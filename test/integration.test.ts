import {
  SELF,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";

const operatorToken = "test-operator-token-only";
type TunnelInfo = {
  id: string;
  url: string;
  connectorToken: string;
  expiresAt: number;
};
type Frame = { type: string; id?: string; [key: string]: unknown };

async function createTunnel(
  options: Record<string, unknown> = {},
): Promise<TunnelInfo> {
  const response = await SELF.fetch("https://example.test/api/tunnels", {
    method: "POST",
    headers: {
      authorization: `Bearer ${operatorToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(options),
  });
  expect(response.status).toBe(200);
  return await response.json<TunnelInfo>();
}

function controlURL(tunnel: TunnelInfo): URL {
  const url = new URL(tunnel.url);
  url.hostname = "example.test";
  url.pathname = `/api/tunnels/${tunnel.id}/connect`;
  url.search = "";
  return url;
}

async function connectorFor(tunnel: TunnelInfo, token = tunnel.connectorToken) {
  const response = await SELF.fetch(controlURL(tunnel), {
    headers: {
      upgrade: "websocket",
      authorization: `Bearer ${token}`,
    },
  });
  expect(response.status).toBe(101);
  expect(response.headers.get("x-tunnel-expires-at")).toBe(
    String(tunnel.expiresAt),
  );
  const socket = response.webSocket;
  if (!socket) throw new Error("Worker did not return the connector WebSocket");
  socket.accept();
  const frames: Frame[] = [];
  const waiters = new Map<string, Array<(frame: Frame) => void>>();
  const ackWaiters = new Map<string, Array<() => void>>();
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Frame;
    if (frame.type === "http_ack" && frame.id) {
      const waiter = ackWaiters.get(frame.id)?.shift();
      if (waiter) waiter();
      return;
    }
    const waiter = waiters.get(frame.type)?.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  return {
    socket,
    frames,
    next(type: string): Promise<Frame> {
      const found = frames.findIndex((frame) => frame.type === type);
      if (found >= 0) return Promise.resolve(frames.splice(found, 1)[0]!);
      return new Promise((resolve) => {
        const list = waiters.get(type) ?? [];
        list.push(resolve);
        waiters.set(type, list);
      });
    },
    ack(id: string): Promise<void> {
      return new Promise((resolve) => {
        const list = ackWaiters.get(id) ?? [];
        list.push(resolve);
        ackWaiters.set(id, list);
      });
    },
  };
}

function visitorRequest(
  tunnel: TunnelInfo,
  path: string,
  init?: RequestInit,
): Request {
  const url = new URL(path, tunnel.url);
  return new Request(url, init);
}

describe("TunnelWorker integration", () => {
  it("creates protected tunnels with expiring credentials and reserves management routes only at the apex", async () => {
    const unauthenticated = await SELF.fetch(
      "https://example.test/api/tunnels",
      { method: "POST", body: "{}" },
    );
    expect(unauthenticated.status).toBe(401);

    const tunnel = await createTunnel({
      ttlSeconds: 300,
      visitorPassword: "correct horse",
    });
    expect(tunnel.id).toMatch(/^[a-f0-9]{36}$/);
    expect(new URL(tunnel.url).hostname).toBe(
      `${tunnel.id}-tunnel.example.test`,
    );
    expect(tunnel.expiresAt).toBeGreaterThan(Date.now());

    const missingPassword = await SELF.fetch(
      visitorRequest(tunnel, "/preview"),
    );
    expect(missingPassword.status).toBe(401);
    const noConnector = await SELF.fetch(
      visitorRequest(tunnel, "/preview", {
        headers: { authorization: `Basic ${btoa("viewer:correct horse")}` },
      }),
    );
    expect(noConnector.status).toBe(503);
    const noPasswordWS = await SELF.fetch(
      visitorRequest(tunnel, "/_next/webpack-hmr", {
        headers: { upgrade: "websocket" },
      }),
    );
    expect(noPasswordWS.status).toBe(401);

    const missingConnectorCredential = await SELF.fetch(controlURL(tunnel), {
      headers: { upgrade: "websocket" },
    });
    expect(missingConnectorCredential.status).toBe(401);
    const badConnectorCredential = await SELF.fetch(controlURL(tunnel), {
      headers: {
        upgrade: "websocket",
        authorization: "Bearer incorrect-connector-token",
      },
    });
    expect(badConnectorCredential.status).toBe(401);
    const malformedControlID = await SELF.fetch(
      "https://example.test/api/tunnels/not-a-tunnel-id/connect",
      { headers: { upgrade: "websocket" } },
    );
    expect(malformedControlID.status).toBe(404);
    const visitorCannotUseControlPath = await SELF.fetch(
      visitorRequest(tunnel, `/api/tunnels/${tunnel.id}/connect`, {
        headers: {
          upgrade: "websocket",
          authorization: `Bearer ${tunnel.connectorToken}`,
        },
      }),
    );
    expect(visitorCannotUseControlPath.status).toBe(401);

    const publicHealth = await SELF.fetch("https://example.test/_health");
    expect(publicHealth.status).toBe(200);
    const wrongHostManagement = await SELF.fetch(
      `https://${tunnel.id}.tunnel.example.test/api/tunnels`,
      { method: "POST" },
    );
    expect(wrongHostManagement.status).toBe(404); // the legacy hostname format is no longer accepted
  });

  it("routes each control ID to its own tunnel and revokes through the control API path", async () => {
    const first = await createTunnel();
    const second = await createTunnel();
    const firstConnector = await connectorFor(first);
    const secondConnector = await connectorFor(second);

    const wrongTunnelCredential = await SELF.fetch(controlURL(second), {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${first.connectorToken}`,
      },
    });
    expect(wrongTunnelCredential.status).toBe(401);

    const firstRequest = SELF.fetch(visitorRequest(first, "/first"));
    const secondRequest = SELF.fetch(visitorRequest(second, "/second"));
    const [firstFrame, secondFrame] = await Promise.all([
      firstConnector.next("http"),
      secondConnector.next("http"),
    ]);
    expect(firstFrame.path).toBe("/first");
    expect(secondFrame.path).toBe("/second");
    for (const [connector, frame, status] of [
      [firstConnector, firstFrame, 201],
      [secondConnector, secondFrame, 202],
    ] as const) {
      await connector.next("http_body_end");
      connector.socket.send(
        JSON.stringify({
          type: "http_start",
          id: frame.id,
          status,
          headers: { "content-type": ["text/plain"] },
        }),
      );
      connector.socket.send(JSON.stringify({ type: "http_end", id: frame.id }));
    }
    const firstResponse = await firstRequest;
    const secondResponse = await secondRequest;
    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(202);
    await firstResponse.arrayBuffer();
    await secondResponse.arrayBuffer();

    const operatorCannotRevoke = await SELF.fetch(
      `https://example.test/api/tunnels/${first.id}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${operatorToken}` },
      },
    );
    expect(operatorCannotRevoke.status).toBe(401);
    const revoked = await SELF.fetch(
      `https://example.test/api/tunnels/${first.id}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${first.connectorToken}` },
      },
    );
    expect(revoked.status).toBe(200);
    const expired = await SELF.fetch(visitorRequest(first, "/after-revoke"));
    expect(expired.status).toBe(410);
    const stillActive = SELF.fetch(visitorRequest(second, "/still-active"));
    const stillActiveFrame = await secondConnector.next("http");
    expect(stillActiveFrame.path).toBe("/still-active");
    await secondConnector.next("http_body_end");
    secondConnector.socket.send(
      JSON.stringify({
        type: "http_start",
        id: stillActiveFrame.id,
        status: 203,
        headers: {},
      }),
    );
    secondConnector.socket.send(
      JSON.stringify({ type: "http_end", id: stillActiveFrame.id }),
    );
    const stillActiveResponse = await stillActive;
    expect(stillActiveResponse.status).toBe(203);
    await stillActiveResponse.arrayBuffer();
    secondConnector.socket.close();
    firstConnector.socket.close();
  });

  it("queues excess visitor HTTP requests and forwards them when a slot opens", async () => {
    const tunnel = await createTunnel();
    const connector = await connectorFor(tunnel);
    const requestCount = 9;
    const requests = Array.from({ length: requestCount }, (_, index) =>
      SELF.fetch(visitorRequest(tunnel, `/parallel/${index}`)),
    );

    const activeFrames = await Promise.all(
      Array.from({ length: 8 }, () => connector.next("http")),
    );
    await Promise.all(activeFrames.map(() => connector.next("http_body_end")));
    const paths = Array.from(
      { length: requestCount },
      (_, index) => `/parallel/${index}`,
    );
    const activePaths = activeFrames.map((frame) => String(frame.path));
    expect(new Set(activePaths).size).toBe(8);
    expect(activePaths.every((path) => paths.includes(path))).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(connector.frames.some((frame) => frame.type === "http")).toBe(false);

    const respond = (frame: Frame) => {
      connector.socket.send(
        JSON.stringify({
          type: "http_start",
          id: frame.id,
          status: 200,
          headers: { "content-type": ["text/plain"] },
        }),
      );
      connector.socket.send(JSON.stringify({ type: "http_end", id: frame.id }));
    };
    respond(activeFrames[0]!);
    const queuedFrame = await connector.next("http");
    expect(queuedFrame.path).toBe(
      paths.find((path) => !activePaths.includes(path)),
    );
    await connector.next("http_body_end");
    respond(queuedFrame);
    for (const frame of activeFrames.slice(1)) respond(frame);

    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: requestCount }, () => 200),
    );
    await Promise.all(responses.map((response) => response.arrayBuffer()));
    connector.socket.close();
  });

  it("rejects queued requests when a tunnel expires", async () => {
    const tunnel = await createTunnel();
    const connector = await connectorFor(tunnel);
    const requestCount = 9;
    const requests = Array.from({ length: requestCount }, (_, index) =>
      SELF.fetch(visitorRequest(tunnel, `/expire-queued/${index}`)),
    );
    const activeFrames = await Promise.all(
      Array.from({ length: 8 }, () => connector.next("http")),
    );
    await Promise.all(activeFrames.map(() => connector.next("http_body_end")));
    const activePaths = activeFrames.map((frame) => String(frame.path));
    const queuedIndex = Array.from(
      { length: requestCount },
      (_, index) => index,
    ).find((index) => !activePaths.includes(`/expire-queued/${index}`));
    if (queuedIndex === undefined) throw new Error("No request was queued");

    const stub = (env as Env).TUNNELS.getByName(tunnel.id);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE tunnel SET expires_at = ?",
        Date.now() - 1,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const responses = await Promise.all(requests);
    expect(responses[queuedIndex]!.status).toBe(410);
    await Promise.all(responses.map((response) => response.arrayBuffer()));
    connector.socket.close();
  });

  it("streams large responses with pull acknowledgements and forwards application paths", async () => {
    const tunnel = await createTunnel();
    const connector = await connectorFor(tunnel);
    const request = SELF.fetch(
      visitorRequest(tunnel, "/_health?app=1", {
        headers: { authorization: `Basic ${btoa("app:credential")}` },
      }),
    );
    const start = await connector.next("http");
    expect(start.path).toBe("/_health?app=1");
    expect((start.headers as Record<string, unknown>).authorization).toEqual([
      `Basic ${btoa("app:credential")}`,
    ]);
    expect(start.headers).toMatchObject({
      "x-forwarded-host": [`${tunnel.id}-tunnel.example.test`],
    });
    await connector.next("http_body_end");
    const id = String(start.id);
    connector.socket.send(
      JSON.stringify({
        type: "http_start",
        id,
        status: 200,
        headers: { "content-type": ["application/octet-stream"] },
      }),
    );
    const part = new Uint8Array(32 * 1024).fill(0x5a);
    const chunk = btoa(String.fromCharCode(...part));
    // Exceed the 8 MiB request body limit to verify downloads are not
    // subject to a cumulative response size cap.
    const count = 300;
    const stream = (async () => {
      for (let i = 0; i < count; i++) {
        connector.socket.send(
          JSON.stringify({ type: "http_chunk", id, data: chunk }),
        );
        await connector.ack(id);
      }
      connector.socket.send(JSON.stringify({ type: "http_end", id }));
    })();
    const response = await request;
    const body = await response.arrayBuffer();
    await stream;
    expect(body.byteLength).toBe(count * part.byteLength);
    expect(new Uint8Array(body)[0]).toBe(0x5a);
    connector.socket.close();
  });

  it("cancels the connector when the visitor cancels a streamed response", async () => {
    const tunnel = await createTunnel();
    const connector = await connectorFor(tunnel);
    const request = SELF.fetch(visitorRequest(tunnel, "/download"));
    const start = await connector.next("http");
    await connector.next("http_body_end");
    const id = String(start.id);
    connector.socket.send(
      JSON.stringify({ type: "http_start", id, status: 200, headers: {} }),
    );
    const response = await request;
    await response.body!.cancel();
    expect(await connector.next("http_cancel")).toMatchObject({ id });
    connector.socket.close();
  });

  it("bootstraps browser WebSocket auth with a cookie, strips only its relay cookie, and relays text/binary frames", async () => {
    const tunnel = await createTunnel({
      ttlSeconds: 300,
      visitorPassword: "secret pass",
    });
    const connector = await connectorFor(tunnel);

    const denied = await SELF.fetch(
      visitorRequest(tunnel, "/socket.io/", {
        headers: { upgrade: "websocket" },
      }),
    );
    expect(denied.status).toBe(401);

    const httpFetch = SELF.fetch(
      visitorRequest(tunnel, "/", {
        headers: {
          authorization: `Basic ${btoa("viewer:secret pass")}`,
          cookie: "app_session=abc",
        },
      }),
    );
    const httpStart = await connector.next("http");
    expect(httpStart.path).toBe("/");
    expect(httpStart.headers).toMatchObject({ cookie: ["app_session=abc"] });
    expect(
      (httpStart.headers as Record<string, unknown>).authorization,
    ).toBeUndefined();
    await connector.next("http_body_end");
    const httpId = String(httpStart.id);
    connector.socket.send(
      JSON.stringify({
        type: "http_start",
        id: httpId,
        status: 200,
        headers: { "content-type": ["text/plain"] },
      }),
    );
    connector.socket.send(JSON.stringify({ type: "http_end", id: httpId }));
    const httpResponse = await httpFetch;
    expect(httpResponse.headers.get("set-cookie")).toContain("HttpOnly");
    const authCookie = httpResponse.headers.get("set-cookie")!.split(";")[0]!;
    await httpResponse.arrayBuffer();

    const cookieFetch = SELF.fetch(
      visitorRequest(tunnel, "/", {
        headers: {
          authorization: `Basic ${btoa("viewer:secret pass")}`,
          cookie: `${authCookie}; app_session=abc`,
        },
      }),
    );
    const cookieStart = await connector.next("http");
    expect(
      (cookieStart.headers as Record<string, unknown>).authorization,
    ).toBeUndefined();
    await connector.next("http_body_end");
    connector.socket.send(
      JSON.stringify({
        type: "http_start",
        id: cookieStart.id,
        status: 200,
        headers: { "content-type": ["text/plain"] },
      }),
    );
    connector.socket.send(
      JSON.stringify({ type: "http_end", id: cookieStart.id }),
    );
    const cookieResponse = await cookieFetch;
    expect(cookieResponse.status).toBe(200);
    await cookieResponse.arrayBuffer();

    const wsPromise = SELF.fetch(
      visitorRequest(tunnel, "/_next/webpack-hmr", {
        headers: {
          authorization: `Basic ${btoa("viewer:secret pass")}`,
          upgrade: "websocket",
          cookie: `${authCookie}; app_session=abc`,
          "sec-websocket-protocol": "hmr-v1",
        },
      }),
    );
    const open = await connector.next("ws_open");
    expect(open.path).toBe("/_next/webpack-hmr");
    expect(open.headers).toMatchObject({ cookie: ["app_session=abc"] });
    connector.socket.send(
      JSON.stringify({ type: "ws_opened", id: open.id, protocol: "hmr-v1" }),
    );
    const wsResponse = await wsPromise;
    expect(wsResponse.status).toBe(101);
    expect(wsResponse.headers.get("sec-websocket-protocol")).toBe("hmr-v1");
    const visitor = wsResponse.webSocket;
    if (!visitor)
      throw new Error("Worker did not return the visitor WebSocket");
    visitor.accept();

    const sent = new Promise<Frame>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        const frame = JSON.parse(String(event.data)) as Frame;
        if (frame.type === "ws_message") {
          connector.socket.removeEventListener("message", onMessage);
          resolve(frame);
        }
      };
      connector.socket.addEventListener("message", onMessage);
    });
    visitor.send("hmr ping");
    const textFrame = await sent;
    expect(textFrame.text).toBe(true);
    expect(atob(String(textFrame.data))).toBe("hmr ping");

    const binary = new Uint8Array([0, 255, 1]);
    const binarySent = new Promise<Frame>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        const frame = JSON.parse(String(event.data)) as Frame;
        if (frame.type === "ws_message") {
          connector.socket.removeEventListener("message", onMessage);
          resolve(frame);
        }
      };
      connector.socket.addEventListener("message", onMessage);
    });
    visitor.send(binary);
    const binaryFrame = await binarySent;
    expect(binaryFrame.text).toBe(false);
    expect(atob(String(binaryFrame.data))).toBe(String.fromCharCode(0, 255, 1));
    visitor.close();
    connector.socket.close();
  });

  it("reconnects without extending expiry and rejects expired traffic", async () => {
    const tunnel = await createTunnel({ ttlSeconds: 60 });
    const first = await connectorFor(tunnel);
    first.socket.close();
    const second = await connectorFor(tunnel);
    expect(second.socket.readyState).toBe(WebSocket.OPEN);
    first.socket.close();
    const request = SELF.fetch(visitorRequest(tunnel, "/still-connected"));
    const frame = await second.next("http");
    expect(frame.path).toBe("/still-connected");
    await second.next("http_body_end");
    second.socket.send(
      JSON.stringify({
        type: "http_start",
        id: frame.id,
        status: 200,
        headers: {},
      }),
    );
    second.socket.send(JSON.stringify({ type: "http_end", id: frame.id }));
    const continued = await request;
    expect(continued.status).toBe(200);
    await continued.arrayBuffer();
    second.socket.close();

    const stub = (env as Env).TUNNELS.getByName(tunnel.id);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE tunnel SET expires_at = ?",
        Date.now() - 1,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    // Force the scheduled cleanup path in workerd without waiting for TTL wall time.
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);
    const expired = await SELF.fetch(visitorRequest(tunnel, "/"));
    expect(expired.status).toBe(410);
  });
});
