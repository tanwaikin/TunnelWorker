#!/usr/bin/env python3
"""Black-box local smoke test: Wrangler/Workerd + Go connector + HTTP/WS origin.

Requires the project's Node dependencies, a Go toolchain (or .tools/go/bin/go),
and aiohttp (see requirements-smoke.txt). Everything binds to loopback; this
script never deploys or uses Cloudflare remote resources.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import gzip
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import ClientSession, ClientTimeout, WSMsgType, web


ROOT = Path(__file__).resolve().parents[1]


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def make_origin_app() -> web.Application:
    app = web.Application(client_max_size=16 * 1024 * 1024)
    ws_observed: dict[str, str | None] = {}

    async def inspect_request(request: web.Request) -> web.Response:
        body = await request.read()
        return web.json_response({
            "method": request.method,
            "path": request.path_qs,
            "body": base64.b64encode(body).decode(),
            "authorization": request.headers.get("Authorization"),
            "cookie": request.headers.get("Cookie"),
            "password": request.headers.get("X-Tunnel-Password"),
            "x-smoke": request.headers.get("X-Smoke"),
        })

    async def echo_body(request: web.Request) -> web.Response:
        return web.Response(body=await request.read(), headers={"X-Origin": "echo"})

    async def head_response(request: web.Request) -> web.Response:
        return web.Response(text="head-body-must-not-be-delivered", headers={"X-Origin": "head"})

    async def no_content(request: web.Request) -> web.Response:
        return web.Response(status=204, headers={"X-Origin": "no-content"})

    async def not_modified(request: web.Request) -> web.Response:
        return web.Response(status=304, headers={"ETag": '"smoke-etag"'})

    async def duplicate_cookies(request: web.Request) -> web.Response:
        response = web.Response(text="cookies")
        response.set_cookie("alpha", "1")
        response.set_cookie("beta", "2")
        return response

    async def compressed(request: web.Request) -> web.Response:
        payload = b"compressed tunnel payload " * 4096
        return web.Response(body=gzip.compress(payload), headers={"Content-Type": "application/octet-stream", "Content-Encoding": "gzip", "X-Origin-Compression": "gzip"})

    async def stream(request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(headers={"Content-Type": "application/octet-stream", "X-Origin-Stream": "yes"})
        await response.prepare(request)
        # 2 MiB total, sent in paced pieces to exercise streamed delivery.
        for index in range(32):
            await response.write(bytes([index]) * (64 * 1024))
            await asyncio.sleep(0.005)
        await response.write_eof()
        return response

    async def ws_echo(request: web.Request) -> web.WebSocketResponse:
        ws_observed.clear()
        ws_observed.update({
            "authorization": request.headers.get("Authorization"),
            "cookie": request.headers.get("Cookie"),
            "password": request.headers.get("X-Tunnel-Password"),
        })
        ws = web.WebSocketResponse(protocols=("hmr.v1",), max_msg_size=4 * 1024 * 1024)
        await ws.prepare(request)
        async for message in ws:
            if message.type == WSMsgType.TEXT:
                await ws.send_str("echo:" + message.data)
            elif message.type == WSMsgType.BINARY:
                await ws.send_bytes(message.data)
            elif message.type == WSMsgType.ERROR:
                break
        return ws

    async def ws_headers(request: web.Request) -> web.Response:
        return web.json_response(ws_observed)

    app.router.add_route("GET", "/inspect", inspect_request)
    app.router.add_route("POST", "/inspect", inspect_request)
    app.router.add_route("PUT", "/inspect", inspect_request)
    app.router.add_route("POST", "/echo", echo_body)
    app.router.add_route("HEAD", "/head", head_response)
    app.router.add_route("GET", "/empty-204", no_content)
    app.router.add_route("GET", "/not-modified-304", not_modified)
    app.router.add_route("GET", "/cookies", duplicate_cookies)
    app.router.add_route("GET", "/compressed", compressed)
    app.router.add_route("GET", "/stream", stream)
    app.router.add_route("GET", "/ws/{tail:.*}", ws_echo)
    app.router.add_route("GET", "/ws_headers", ws_headers)
    return app


async def wait_for_worker(base_url: str, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 20
    last_status: int | None = None
    async with ClientSession(timeout=ClientTimeout(total=3), trust_env=False) as session:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"Wrangler exited early with status {process.returncode}")
            try:
                async with session.get(base_url + "/_health", headers={"Host": "dev.example.net"}) as response:
                    last_status = response.status
                    if response.status == 200:
                        return
            except Exception:
                pass
            await asyncio.sleep(0.25)
    raise TimeoutError(f"Wrangler local Worker did not become ready within 20 seconds (last health status: {last_status})")


def connector_binary() -> Path:
    configured = os.environ.get("TUNNELWORKER_BIN")
    if configured:
        path = Path(configured).expanduser().resolve()
        check(path.is_file(), f"TUNNELWORKER_BIN does not exist: {path}")
        return path
    go = ROOT / ".tools/go/bin/go"
    if not go.is_file():
        found = shutil.which("go")
        check(found is not None, "Go not found; set TUNNELWORKER_BIN or install Go")
        go = Path(found)
    target = Path(tempfile.gettempdir()) / f"tunnelworker-smoke-{os.getpid()}"
    result = subprocess.run([str(go), "build", "-o", str(target), "./cmd/tunnelworker"], cwd=ROOT, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"Go build failed:\n{result.stdout}\n{result.stderr}")
    return target


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker-url", help="Use an already-running local Wrangler Worker")
    parser.add_argument("--skip-expiry", action="store_true", help="Skip the 60-second TTL and reconnection test")
    args = parser.parse_args()

    token = os.environ.get("TUNNELWORKER_TOKEN") or ("smoke-operator-" + base64.urlsafe_b64encode(os.urandom(18)).decode().rstrip("="))
    worker_port = free_port()
    worker_url = (args.worker_url or f"http://127.0.0.1:{worker_port}").rstrip("/")
    worker_host = urlsplit(worker_url).hostname
    check(worker_host in {"127.0.0.1", "localhost", "::1"}, "smoke tests only support a loopback Wrangler URL")
    origin_port = free_port()
    origin_url = f"http://127.0.0.1:{origin_port}"
    origin_runner = web.AppRunner(make_origin_app())
    await origin_runner.setup()
    await web.TCPSite(origin_runner, "127.0.0.1", origin_port).start()

    temp = tempfile.TemporaryDirectory(prefix="tunnelworker-smoke-")
    temp_path = Path(temp.name)
    wrangler: subprocess.Popen[bytes] | None = None
    binary: Path | None = None
    connector_processes: list[subprocess.Popen[bytes]] = []
    try:
        if not args.worker_url:
            wrangler_log = open(temp_path / "wrangler.log", "wb")
            wrangler = subprocess.Popen(
                ["npx", "wrangler", "dev", "--config", "wrangler.local.jsonc", "--local", "--ip", "127.0.0.1", "--port", str(worker_port),
                 "--var", f"OPERATOR_TOKEN:{token}", "--persist-to", str(temp_path / "state"), "--show-interactive-dev-session=false"],
                cwd=ROOT,
                stdout=wrangler_log,
                stderr=subprocess.STDOUT,
                env={**os.environ, "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"},
            )
            await wait_for_worker(worker_url, wrangler)

        binary = connector_binary()
        print(f"Using local Worker at {worker_url}")
        print(f"Using Go connector {binary}")
        async with ClientSession(timeout=ClientTimeout(total=20), trust_env=False, cookie_jar=None) as session:
            def log_path(name: str) -> Path:
                return temp_path / f"{name}.log"

            def start_connector(name: str, port: int, *, ttl: str = "10m", password: str | None = None,
                                connect_id: str | None = None, connector_token: str | None = None,
                                session_file: Path | None = None) -> subprocess.Popen[bytes]:
                cmd = [str(binary), "--url", worker_url, "--port", str(port)]
                if connect_id:
                    cmd.extend(["--connect", connect_id, "--token", connector_token or ""])
                else:
                    cmd.extend(["--ttl", ttl])
                    if password:
                        cmd.extend(["--password", password])
                if session_file:
                    cmd.extend(["--session-file", str(session_file)])
                output = open(log_path(name), "wb")
                proc = subprocess.Popen(cmd, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT,
                                        env={**os.environ, "TUNNELWORKER_TOKEN": token,
                                             "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"})
                connector_processes.append(proc)
                return proc

            async def find_created(proc: subprocess.Popen[bytes], name: str, timeout: float = 30) -> tuple[str, str, float]:
                path = log_path(name)
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    if proc.poll() is not None:
                        raise RuntimeError(f"Connector exited early ({proc.returncode}): {path.read_text(errors='replace')}")
                    output = path.read_text(errors="replace") if path.exists() else ""
                    match = re.search(r"Tunnel:\s+https://([a-z0-9_-]+)\.dev\.example\.net", output)
                    expiry = re.search(r"Expires:\s+([^\r\n]+)", output)
                    if match and expiry:
                        from datetime import datetime
                        return match.group(1), expiry.group(1).strip(), datetime.fromisoformat(expiry.group(1).strip().replace("Z", "+00:00")).timestamp()
                    await asyncio.sleep(0.1)
                raise TimeoutError(f"Connector did not print tunnel details:\n{path.read_text(errors='replace')}")

            async def wait_tunnel(host: str, expected: int = 200, timeout: float = 20) -> None:
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    try:
                        async with session.get(worker_url + "/inspect", headers={"Host": host}) as response:
                            if response.status == expected:
                                return
                    except Exception:
                        pass
                    await asyncio.sleep(0.2)
                raise TimeoutError(f"Tunnel {host} did not return HTTP {expected}")

            # Unprotected tunnel: HTTP methods, query, large streaming body, WS.
            main_session_file = temp_path / "main-session.json"
            proc = start_connector("main", origin_port, session_file=main_session_file)
            tunnel_id, _, _ = await find_created(proc, "main")
            host = f"{tunnel_id}.dev.example.net"
            await wait_tunnel(host)

            async with session.get(worker_url + "/inspect?x=1", headers={"Host": host, "X-Smoke": "get"}) as response:
                check(response.status == 200, f"GET returned {response.status}")
                payload = await response.json()
                check(payload["method"] == "GET" and payload["path"] == "/inspect?x=1", "GET method/path did not reach origin")
                check(payload["x-smoke"] == "get", "GET application header did not reach origin")

            post_body = os.urandom(180_000)
            async with session.post(worker_url + "/echo", data=post_body, headers={"Host": host}) as response:
                check(response.status == 200 and await response.read() == post_body, "POST body/response did not round-trip")

            async with session.get(worker_url + "/empty-204", headers={"Host": host}) as response:
                check(response.status == 204 and response.headers.get("X-Origin") == "no-content", "204 response failed")
                check(await response.read() == b"", "204 response unexpectedly contained a body")
            async with session.head(worker_url + "/head", headers={"Host": host}) as response:
                check(response.status == 200 and response.headers.get("X-Origin") == "head", "HEAD response status/headers did not round-trip")
                check(await response.read() == b"", "HEAD response unexpectedly contained a body")
            async with session.get(worker_url + "/not-modified-304", headers={"Host": host}) as response:
                check(response.status == 304 and response.headers.get("ETag") == '"smoke-etag"', "304 response headers failed")
                check(await response.read() == b"", "304 response unexpectedly contained a body")
            async with session.get(worker_url + "/cookies", headers={"Host": host}) as response:
                cookies = response.headers.getall("Set-Cookie", [])
                check(len(cookies) == 2 and any(c.startswith("alpha=1") for c in cookies) and any(c.startswith("beta=2") for c in cookies),
                      f"duplicate Set-Cookie headers were not preserved: {cookies!r}")
                await response.read()
            async with ClientSession(timeout=ClientTimeout(total=20), trust_env=False, auto_decompress=False) as raw_session:
                async with raw_session.get(worker_url + "/compressed", headers={"Host": host}) as response:
                    raw_gzip = await response.read()
                    check(response.status == 200 and response.headers.get("Content-Encoding") == "gzip", "compressed response lost its encoding")
                    check(gzip.decompress(raw_gzip) == b"compressed tunnel payload " * 4096, "compressed response bytes changed")
            print("PASS: HTTP methods, 2MiB streaming, bodyless statuses, repeated headers, and gzip")

            async with session.get(worker_url + "/stream", headers={"Host": host}) as response:
                streamed = await response.read()
                check(response.status == 200 and len(streamed) == 2 * 1024 * 1024, f"stream expected 2 MiB, got {response.status}/{len(streamed)} bytes")
                check(streamed[:65536] == bytes([0]) * 65536 and streamed[-65536:] == bytes([31]) * 65536, "stream chunks were corrupted or reordered")

            ws_url = worker_url.replace("http://", "ws://").replace("https://", "wss://") + "/ws/hmr?channel=dev"
            try:
                async with session.ws_connect(ws_url, headers={"Host": host}, protocols=("chat", "hmr.v1")) as ws:
                    check(ws.protocol == "hmr.v1", f"WS subprotocol not negotiated: {ws.protocol!r}")
                    await ws.send_str("hello")
                    text_message = await ws.receive(timeout=10)
                    check(text_message.type == WSMsgType.TEXT and text_message.data == "echo:hello", f"WS text echo failed: {text_message!r}")
                    binary_payload = b"\x00\x01binary\xff"
                    await ws.send_bytes(binary_payload)
                    binary_message = await ws.receive(timeout=10)
                    check(binary_message.type == WSMsgType.BINARY and binary_message.data == binary_payload, f"WS binary echo failed: {binary_message!r}")
            except Exception:
                async with session.get(origin_url + "/ws_headers") as response:
                    print(f"Origin saw WS handshake headers: {await response.json()}", file=sys.stderr)
                raise
            print("PASS: WebSocket text/binary frames and subprotocol negotiation")

            # A visitor password must protect both HTTP and browser WS. HTTP Basic
            # bootstraps a cookie, which a browser's WebSocket API sends automatically.
            password = "smoke-password-42"
            protected_session_file = temp_path / "protected-session.json"
            protected_proc = start_connector("protected", origin_port, password=password, session_file=protected_session_file)
            protected_id, _, _ = await find_created(protected_proc, "protected")
            protected_host = f"{protected_id}.dev.example.net"
            # The default readiness probe is intentionally unauthenticated; a
            # protected tunnel is ready once it consistently answers 401.
            await wait_tunnel(protected_host, expected=401)

            async with session.get(worker_url + "/inspect", headers={"Host": protected_host}) as response:
                check(response.status == 401, f"unauthenticated HTTP expected 401, got {response.status}")
                await response.read()
            ws_url = worker_url.replace("http://", "ws://").replace("https://", "wss://") + "/ws/hmr"
            try:
                await session.ws_connect(ws_url, headers={"Host": protected_host}, protocols=("hmr.v1",))
            except Exception as error:
                status = getattr(error, "status", None)
                check(status == 401, f"unauthenticated WS should reject with 401, got {status}: {error}")
            else:
                raise AssertionError("unauthenticated WebSocket unexpectedly upgraded")

            basic = base64.b64encode(f"visitor:{password}".encode()).decode()
            async with session.get(worker_url + "/inspect", headers={"Host": protected_host, "Authorization": f"Basic {basic}"}) as response:
                check(response.status == 200, f"valid Basic password expected 200, got {response.status}")
                cookie_headers = response.headers.getall("Set-Cookie", [])
                check(cookie_headers, "successful Basic authentication did not set a browser WS cookie")
                payload = await response.json()
                check(payload["authorization"] is None, "visitor Basic credentials leaked to local origin")
                from http.cookies import SimpleCookie
                parsed = SimpleCookie()
                for header in cookie_headers:
                    parsed.load(header)
                cookie = "; ".join(f"{key}={morsel.value}" for key, morsel in parsed.items())
                check(cookie, "Set-Cookie could not be parsed for browser WS auth")
            async with session.ws_connect(ws_url, headers={"Host": protected_host, "Cookie": cookie}, protocols=("hmr.v1",)) as ws:
                check(ws.protocol == "hmr.v1", f"protected WS subprotocol failed: {ws.protocol!r}")
                await ws.send_str("protected")
                answer = await ws.receive(timeout=10)
                check(answer.type == WSMsgType.TEXT and answer.data == "echo:protected", "cookie-authenticated WS text echo failed")
            async with session.get(origin_url + "/ws_headers") as response:
                forwarded = await response.json()
                check(forwarded.get("authorization") is None and forwarded.get("password") is None,
                      "visitor WebSocket credentials leaked to local origin")
                check(password not in (forwarded.get("cookie") or ""), "visitor password leaked in forwarded WebSocket cookies")
            print("PASS: visitor password rejects HTTP/WS and Basic auth bootstraps cookie-authenticated browser WS")

            if not args.skip_expiry:
                # TTL is the platform's minimum 60 seconds. Resume after most of
                # the original lifetime, then verify it still expires on schedule.
                expiry_session = temp_path / "expiry-session.json"
                expiry_proc = start_connector("expiry", origin_port, ttl="1m", session_file=expiry_session)
                expiry_id, _, expires_at = await find_created(expiry_proc, "expiry")
                expiry_host = f"{expiry_id}.dev.example.net"
                await wait_tunnel(expiry_host)
                initial_state = json.loads(expiry_session.read_text())
                if isinstance(initial_state.get("expiresAt"), int):
                    # The CLI display is second-resolution; use persisted epoch
                    # milliseconds to avoid checking up to one second too early.
                    expires_at = initial_state["expiresAt"] / 1000
                connector_token = (initial_state.get("connectorToken") or initial_state.get("connector_token")
                                   or initial_state.get("token"))
                check(isinstance(connector_token, str) and connector_token, "session file lacks connector credential for resume test")
                # Leave a clear gap between original expiry and a mistakenly reset 1m expiry.
                remaining = expires_at - time.time()
                await asyncio.sleep(max(0, remaining - 15))
                # SIGKILL simulates process loss so the CLI's deliberate shutdown
                # cleanup cannot revoke the tunnel or delete its session file.
                expiry_proc.kill()
                try:
                    expiry_proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    expiry_proc.kill()
                    expiry_proc.wait(timeout=5)
                resumed = start_connector("resumed", origin_port, connect_id=expiry_id,
                                          connector_token=connector_token, session_file=expiry_session)
                await asyncio.sleep(1.5)
                check(resumed.poll() is None, f"connector failed to resume: {log_path('resumed').read_text(errors='replace')}")
                try:
                    async with session.get(worker_url + "/inspect", headers={"Host": expiry_host}) as response:
                        check(response.status == 200, f"resumed tunnel should work before original expiry, got {response.status}")
                        await response.read()
                except Exception as error:
                    raise AssertionError(f"resumed tunnel request failed: {error}") from error
                await asyncio.sleep(max(0, expires_at - time.time() + 0.25))
                async with session.get(worker_url + "/inspect", headers={"Host": expiry_host}) as response:
                    check(response.status == 410, f"expired tunnel should return 410, got {response.status}")
                    await response.read()
                print("PASS: reconnect retained the original absolute expiry; expired route returned 410")

            # Origin failure should resolve promptly into a useful gateway error.
            await origin_runner.cleanup()
            async with session.get(worker_url + "/inspect", headers={"Host": host}) as response:
                check(response.status in (502, 503, 504), f"unavailable origin expected 502/503/504, got {response.status}")
                await response.read()
            print("PASS: unavailable origin returns a bounded gateway failure")

            # A deliberate CLI shutdown should revoke its tunnel promptly.
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired as error:
                raise AssertionError("graceful connector shutdown exceeded 5 seconds") from error
            check(proc.returncode == 0, f"graceful connector shutdown returned {proc.returncode}: {log_path('main').read_text(errors='replace')}")
            async with session.get(worker_url + "/inspect", headers={"Host": host}) as response:
                check(response.status == 410, f"gracefully stopped tunnel should return 410, got {response.status}")
                await response.read()
            print("PASS: graceful connector shutdown revoked its tunnel and returned 410")

        print("PASS: real Wrangler/Workerd + Go connector HTTP, streaming, WebSocket, password, and origin failure smoke tests")
    except BaseException:
        for log_path in sorted(temp_path.glob("*.log")):
            try:
                print(f"--- {log_path.name} ---", file=sys.stderr)
                print(log_path.read_text(errors="replace"), file=sys.stderr)
            except OSError:
                pass
        raise
    finally:
        for proc in connector_processes:
            if proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
        for proc in connector_processes:
            if proc.poll() is None:
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=3)
        if wrangler and wrangler.poll() is None:
            wrangler.send_signal(signal.SIGTERM)
            try:
                wrangler.wait(timeout=5)
            except subprocess.TimeoutExpired:
                wrangler.kill()
                wrangler.wait(timeout=5)
        await origin_runner.cleanup()
        temp.cleanup()
        if binary and binary.parent == Path(tempfile.gettempdir()) and binary.name.startswith(f"tunnelworker-smoke-{os.getpid()}"):
            binary.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise
