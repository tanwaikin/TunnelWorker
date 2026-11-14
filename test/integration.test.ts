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

async function connectorFor(tunnel: TunnelInfo) {
  const response = await SELF.fetch(`${tunnel.url}/_control`, {
    headers: {
      upgrade: "websocket",
      authorization: `Bearer ${tunnel.connectorToken}`,
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
    expect(new URL(tunnel.url).hostname).toBe(`${tunnel.id}.example.test`);
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

    const publicHealth = await SELF.fetch("https://example.test/_health");
    expect(publicHealth.status).toBe(200);
    const wrongHostManagement = await SELF.fetch(
      `https://${tunnel.id}.example.test/api/tunnels`,
      { method: "POST" },
    );
    expect(wrongHostManagement.status).toBe(401); // forwarded through the tunnel's visitor auth boundary
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
      "x-forwarded-host": [`${tunnel.id}.example.test`],
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
    const count = 40;
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
