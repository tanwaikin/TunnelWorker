import { DurableObject } from "cloudflare:workers";
import { hashSecret, matchesSecret, randomSecret } from "./protocol";

export interface Env extends Omit<Cloudflare.Env, "VISITOR_DOMAIN"> {
  OPERATOR_TOKEN: string;
  VISITOR_DOMAIN: string;
}

interface CreateRequest {
  ttlSeconds?: number;
  visitorPassword?: string;
}
interface CreateConfig {
  id: string;
  connectorHash: string;
  visitorHash: string | null;
  expiresAt: number;
  maxBody: number;
}
interface Attachment {
  role: "connector" | "visitor";
  wsId?: string;
}
interface Pending {
  controller: ReadableStreamDefaultController<Uint8Array>;
  status?: number;
  headers?: Headers;
  started: boolean;
  bytes: number;
  queued: number;
  resolve?: (v: {
    status: number;
    headers: Headers;
    body: ReadableStream<Uint8Array>;
  }) => void;
  reject?: (e: Error) => void;
  cleanup?: () => void;
  body?: ReadableStream<Uint8Array>;
  connector?: WebSocket;
  timer?: ReturnType<typeof setTimeout>;
  release?: () => void;
}
type HttpSlotResult = { release: () => void } | { response: Response };
interface HttpWaiter {
  signal: AbortSignal;
  resolve: (result: HttpSlotResult) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort: () => void;
}

const MAX_ACTIVE_HTTP = 8;
const MAX_QUEUED_HTTP = 32;
const HTTP_QUEUE_TIMEOUT_MS = 15_000;

function json(value: unknown, status = 200, headers = new Headers()): Response {
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(value), { status, headers });
}
function constantTimeStringEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
async function readCreateBody(request: Request): Promise<CreateRequest | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(raw));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as CreateRequest)
      : null;
  } catch {
    return null;
  }
}
function bearer(request: Request): string {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
}
function isUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}
function isTunnelId(value: string): boolean {
  return /^[a-f0-9]{36}$/.test(value);
}
function internalControlRequest(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = "/_control";
  return new Request(url, request);
}
function randomId(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
function cookieValue(request: Request): string | null {
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("tw_auth="))
      ?.slice(8) ?? null
  );
}
async function validCookie(
  request: Request,
  config: CreateConfig,
): Promise<boolean> {
  if (!config.visitorHash) return true;
  const supplied = cookieValue(request);
  if (!supplied) return false;
  const data = new TextEncoder().encode(`${config.id}.${config.expiresAt}`);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(config.visitorHash),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  const expected = btoa(String.fromCharCode(...sig))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return constantTimeStringEqual(supplied, expected);
}
async function authCookie(config: CreateConfig): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(config.visitorHash!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${config.id}.${config.expiresAt}`),
    ),
  );
  const value = btoa(String.fromCharCode(...sig))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `tw_auth=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${new Date(config.expiresAt).toUTCString()}`;
}
function visitorHeaders(
  request: Request,
  stripBasic = false,
): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  request.headers.forEach((value, key) => {
    if (
      /^(host|connection|upgrade|content-length|transfer-encoding|x-tunnel-password|sec-websocket-key|sec-websocket-version|sec-websocket-extensions|sec-websocket-protocol)$/i.test(
        key,
      )
    )
      return;
    if (
      stripBasic &&
      key.toLowerCase() === "authorization" &&
      /^Basic\s/i.test(value)
    )
      return;
    if (key.toLowerCase() === "cookie") {
      const cookies = value
        .split(";")
        .map((v) => v.trim())
        .filter((v) => v && !v.startsWith("tw_auth="));
      if (cookies.length) headers[key] = [cookies.join("; ")];
      return;
    }
    headers[key] = [value];
  });
  return headers;
}
function headersFromFrame(value: unknown): Headers {
  const headers = new Headers();
  if (!value || typeof value !== "object") return headers;
  for (const [name, raw] of Object.entries(value)) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const item of values)
      if (typeof item === "string") headers.append(name, item);
  }
  return headers;
}
function basicPassword(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Basic\s/i.test(authorization)) return null;
  try {
    return atob(authorization.replace(/^Basic\s+/i, ""))
      .split(":")
      .slice(1)
      .join(":");
  } catch {
    return "";
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const controlDomain: string = env.BASE_DOMAIN;
    const visitorDomain: string = env.VISITOR_DOMAIN;
    if (!controlDomain)
      return json({ error: "base_domain_not_configured" }, 503);
    if (!visitorDomain)
      return json({ error: "visitor_domain_not_configured" }, 503);
    const host = url.hostname.toLowerCase();
    if (host === controlDomain && url.pathname === "/_health")
      return json({ status: "ok" });
    if (host === controlDomain) {
      const connect = url.pathname.match(/^\/api\/tunnels\/([^/]+)\/connect$/);
      if (connect) {
        if (!isTunnelId(connect[1]!)) return json({ error: "not_found" }, 404);
        if (request.method !== "GET")
          return json({ error: "method_not_allowed" }, 405);
        return env.TUNNELS.getByName(connect[1]!).fetch(
          internalControlRequest(request),
        );
      }
      const revoke = url.pathname.match(/^\/api\/tunnels\/([^/]+)$/);
      if (revoke && request.method === "DELETE") {
        if (!isTunnelId(revoke[1]!)) return json({ error: "not_found" }, 404);
        return env.TUNNELS.getByName(revoke[1]!).fetch(
          internalControlRequest(request),
        );
      }
    }
    if (
      host === controlDomain &&
      url.pathname === "/api/tunnels" &&
      request.method === "POST"
    ) {
      if (
        !env.OPERATOR_TOKEN ||
        !bearer(request) ||
        !(await matchesSecret(
          bearer(request),
          await hashSecret(env.OPERATOR_TOKEN),
        ))
      )
        return json({ error: "unauthorized" }, 401);
      const body = await readCreateBody(request);
      if (!body) return json({ error: "invalid_json_or_too_large" }, 400);
      const requested =
        body.ttlSeconds ?? Number(env.DEFAULT_TTL_SECONDS || 1800);
      const max = Number(env.MAX_TTL_SECONDS || 86400);
      if (
        !Number.isInteger(requested) ||
        requested < 60 ||
        requested > max ||
        requested > 86400
      )
        return json(
          { error: "ttl_out_of_range", maxSeconds: Math.min(max, 86400) },
          400,
        );
      if (
        body.visitorPassword !== undefined &&
        (typeof body.visitorPassword !== "string" ||
          body.visitorPassword.length < 8 ||
          body.visitorPassword.length > 1024)
      )
        return json({ error: "password_length" }, 400);
      const connectorToken = randomSecret();
      const expiresAt = Date.now() + requested * 1000;
      const maxBodyRaw = Number(env.MAX_BODY_BYTES || 8388608);
      let id = "";
      const configBase = {
        connectorHash: await hashSecret(connectorToken),
        visitorHash: body.visitorPassword
          ? await hashSecret(body.visitorPassword)
          : null,
        expiresAt,
        maxBody: Number.isFinite(maxBodyRaw)
          ? Math.max(1024, Math.min(8 * 1024 * 1024, Math.floor(maxBodyRaw)))
          : 8388608,
      };
      for (let attempt = 0; attempt < 5; attempt++) {
        id = randomId();
        const stub = env.TUNNELS.getByName(id);
        if (await stub.initialize({ id, ...configBase })) {
          break;
        }
        id = "";
      }
      if (!id) return json({ error: "allocation_failed" }, 503);
      return json({
        id,
        url: `https://${id}-tunnel.${visitorDomain}`,
        connectorToken,
        expiresAt,
      });
    }
    const suffix = `-tunnel.${visitorDomain}`;
    if (!host.endsWith(suffix)) return json({ error: "not_found" }, 404);
    const id = host.slice(0, -suffix.length);
    if (!isTunnelId(id)) return json({ error: "not_found" }, 404);
    return env.TUNNELS.getByName(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class Tunnel extends DurableObject<Env> {
  private pending = new Map<string, Pending>();
  private pendingWs = new Map<
    string,
    {
      resolve: (protocol: string) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private activeHttp = 0;
  private httpQueue: HttpWaiter[] = [];
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS tunnel (id TEXT PRIMARY KEY, connector_hash TEXT NOT NULL, visitor_hash TEXT, expires_at INTEGER NOT NULL, max_body INTEGER NOT NULL)",
      );
    });
  }
  private get config(): CreateConfig | null {
    const row = this.ctx.storage.sql
      .exec<{
        id: string;
        connector_hash: string;
        visitor_hash: string | null;
        expires_at: number;
        max_body: number;
      }>("SELECT * FROM tunnel LIMIT 1")
      .toArray()[0];
    return row
      ? {
          id: row.id,
          connectorHash: row.connector_hash,
          visitorHash: row.visitor_hash,
          expiresAt: row.expires_at,
          maxBody: row.max_body,
        }
      : null;
  }
  async initialize(config: CreateConfig): Promise<boolean> {
    if (this.config) return false;
    this.ctx.storage.sql.exec(
      "INSERT INTO tunnel (id,connector_hash,visitor_hash,expires_at,max_body) VALUES (?,?,?,?,?)",
      config.id,
      config.connectorHash,
      config.visitorHash,
      config.expiresAt,
      config.maxBody,
    );
    await this.ctx.storage.setAlarm(config.expiresAt);
    return true;
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const config = this.config;
    if (!config || Date.now() >= config.expiresAt) {
      await this.expire();
      return json({ error: "tunnel_expired" }, 410);
    }
    if (url.pathname === "/_control") return this.control(request, config);
    if (isUpgrade(request)) return this.visitorUpgrade(request, config);
    return this.http(request, config);
  }
  private async control(
    request: Request,
    config: CreateConfig,
  ): Promise<Response> {
    if (!(await matchesSecret(bearer(request), config.connectorHash)))
      return json({ error: "unauthorized" }, 401);
    if (request.method === "DELETE") {
      await this.expire();
      return json({ ok: true });
    }
    if (!isUpgrade(request)) return json({ error: "websocket_required" }, 426);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: "connector" } satisfies Attachment);
    for (const socket of this.ctx.getWebSockets())
      if (
        socket !== server &&
        (socket.deserializeAttachment() as Attachment | null)?.role ===
          "connector"
      )
        socket.close(1012, "connector replaced");
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: {
        "x-tunnel-id": config.id,
        "x-tunnel-expires-at": String(config.expiresAt),
      },
    });
  }
  private connector(): WebSocket | null {
    return (
      this.ctx
        .getWebSockets()
        .find(
          (socket) =>
            socket.readyState === WebSocket.OPEN &&
            (socket.deserializeAttachment() as Attachment | null)?.role ===
              "connector",
        ) ?? null
    );
  }
  private async visitorUpgrade(
    request: Request,
    config: CreateConfig,
  ): Promise<Response> {
    let stripBasic = false;
    if (config.visitorHash) {
      const cookieValid = await validCookie(request, config);
      const password =
        request.headers.get("x-tunnel-password") ??
        basicPassword(request) ??
        "";
      if (!cookieValid && !(await matchesSecret(password, config.visitorHash)))
        return json({ error: "password_required" }, 401);
      const basic = basicPassword(request);
      stripBasic =
        basic !== null && (await matchesSecret(basic, config.visitorHash));
    }
    const connector = this.connector();
    if (!connector) return json({ error: "connector_offline" }, 503);
    const visitorCount = this.ctx.getWebSockets().filter((socket) => {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      return attachment?.role === "visitor";
    }).length;
    if (visitorCount >= 64) return json({ error: "visitor_socket_limit" }, 503);
    const id = crypto.randomUUID();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      role: "visitor",
      wsId: id,
    } satisfies Attachment);
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    const headers = visitorHeaders(request, stripBasic);
    headers["x-forwarded-host"] = [new URL(request.url).host];
    headers["x-forwarded-proto"] = [new URL(request.url).protocol.slice(0, -1)];
    connector.send(
      JSON.stringify({
        type: "ws_open",
        id,
        path: new URL(request.url).pathname + new URL(request.url).search,
        headers,
        protocols,
      }),
    );
    let protocol = "";
    try {
      protocol = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingWs.delete(id);
          reject(new Error("local websocket timeout"));
        }, 10_000);
        this.pendingWs.set(id, { resolve, reject, timer });
      });
    } catch {
      server.close(1011, "local websocket failed");
      return json({ error: "local_websocket_failed" }, 502);
    }
    if (protocol && !protocols.includes(protocol)) {
      server.close(1011, "invalid local protocol");
      return json({ error: "invalid_local_protocol" }, 502);
    }
    const upgradeHeaders = new Headers();
    if (protocol) upgradeHeaders.set("sec-websocket-protocol", protocol);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: upgradeHeaders,
    });
  }
  private async http(
    request: Request,
    config: CreateConfig,
  ): Promise<Response> {
    let setCookie = "";
    let basicUsed = false;
    const authorization = request.headers.get("authorization") ?? "";
    const isBasic = /^Basic\s/i.test(authorization);
    let basicPassword = "";
    if (isBasic) {
      try {
        basicPassword = atob(authorization.replace(/^Basic\s+/i, ""))
          .split(":")
          .slice(1)
          .join(":");
      } catch {
        basicPassword = "";
      }
    }
    try {
      const cookieValid = await validCookie(request, config);
      if (config.visitorHash && !cookieValid) {
        const supplied =
          request.headers.get("x-tunnel-password") ?? basicPassword;
        if (!(await matchesSecret(supplied, config.visitorHash)))
          return json(
            { error: "password_required" },
            401,
            new Headers({ "www-authenticate": 'Basic realm="TunnelWorker"' }),
          );
        basicUsed =
          isBasic && (await matchesSecret(basicPassword, config.visitorHash));
        setCookie = await authCookie(config);
      } else if (config.visitorHash && isBasic) {
        // Browser Basic authentication may accompany the HMAC cookie on every
        // request. Consume it only when it is the tunnel password, preserving
        // unrelated application Basic credentials.
        basicUsed = await matchesSecret(basicPassword, config.visitorHash);
      }
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error ? error.message : "authentication_failed",
        },
        502,
      );
    }
    if (!this.connector()) return json({ error: "connector_offline" }, 503);

    const slot = await this.acquireHttpSlot(request.signal);
    if ("response" in slot) return slot.response;
    const release = slot.release;
    let handedOff = false;
    try {
      if (request.signal.aborted) return this.cancelledRequestResponse();
      const connector = this.connector();
      if (!connector) return json({ error: "connector_offline" }, 503);
      const requestId = crypto.randomUUID();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (request.body) {
        const reader = request.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > config.maxBody) {
              await reader.cancel();
              return json(
                { error: "body_too_large", limit: config.maxBody },
                413,
              );
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const body = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      const headers = visitorHeaders(request, basicUsed);
      headers["x-forwarded-host"] = [new URL(request.url).host];
      headers["x-forwarded-proto"] = [
        new URL(request.url).protocol.slice(0, -1),
      ];
      const wait = this.waitResponse(
        requestId,
        request.signal,
        connector,
        release,
      );
      void wait.catch(() => {});
      connector.send(
        JSON.stringify({
          type: "http",
          id: requestId,
          method: request.method,
          path: new URL(request.url).pathname + new URL(request.url).search,
          headers,
        }),
      );
      for (let pos = 0; pos < body.length; pos += 36 * 1024)
        connector.send(
          JSON.stringify({
            type: "http_body",
            id: requestId,
            data: encodeB64(body.subarray(pos, pos + 36 * 1024)),
          }),
        );
      connector.send(JSON.stringify({ type: "http_body_end", id: requestId }));
      const result = await wait;
      if (setCookie) result.headers.append("set-cookie", setCookie);
      result.headers.set("cache-control", "no-store");
      const noBody =
        request.method === "HEAD" || [204, 205, 304].includes(result.status);
      if (noBody) {
        await result.body.cancel("response has no body");
        handedOff = true;
        return new Response(null, {
          status: result.status,
          headers: result.headers,
          encodeBody: "manual",
        });
      }
      handedOff = true;
      return new Response(result.body, {
        status: result.status,
        headers: result.headers,
        encodeBody: "manual",
      });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "relay_failed" },
        502,
      );
    } finally {
      if (!handedOff) release();
    }
  }
  private acquireHttpSlot(signal: AbortSignal): Promise<HttpSlotResult> {
    if (signal.aborted)
      return Promise.resolve({ response: this.cancelledRequestResponse() });
    if (this.activeHttp < MAX_ACTIVE_HTTP) {
      this.activeHttp++;
      return Promise.resolve({ release: this.createHttpRelease() });
    }
    if (this.httpQueue.length >= MAX_QUEUED_HTTP)
      return Promise.resolve({
        response: json(
          { error: "tunnel_overloaded" },
          503,
          new Headers({ "retry-after": "1" }),
        ),
      });

    return new Promise((resolve) => {
      let waiter: HttpWaiter;
      const cleanup = () => {
        clearTimeout(waiter.timer);
        signal.removeEventListener("abort", waiter.onAbort);
        const index = this.httpQueue.indexOf(waiter);
        if (index >= 0) this.httpQueue.splice(index, 1);
      };
      const finish = (result: HttpSlotResult) => {
        cleanup();
        resolve(result);
      };
      waiter = {
        signal,
        resolve: finish,
        timer: setTimeout(() => {
          finish({
            response: json(
              { error: "tunnel_queue_timeout" },
              503,
              new Headers({ "retry-after": "1" }),
            ),
          });
        }, HTTP_QUEUE_TIMEOUT_MS),
        onAbort: () => finish({ response: this.cancelledRequestResponse() }),
      };
      this.httpQueue.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal.aborted) waiter.onAbort();
    });
  }
  private createHttpRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseHttpSlot();
    };
  }
  private releaseHttpSlot(): void {
    while (this.httpQueue.length > 0) {
      const waiter = this.httpQueue.shift()!;
      clearTimeout(waiter.timer);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.resolve({ response: this.cancelledRequestResponse() });
        continue;
      }
      waiter.resolve({ release: this.createHttpRelease() });
      return;
    }
    this.activeHttp--;
  }
  private cancelledRequestResponse(): Response {
    return new Response(null, {
      status: 499,
      headers: new Headers({ "cache-control": "no-store" }),
    });
  }
  private waitResponse(
    id: string,
    signal: AbortSignal,
    connector: WebSocket,
    release: () => void,
  ): Promise<{
    status: number;
    headers: Headers;
    body: ReadableStream<Uint8Array>;
  }> {
    return new Promise((resolve, reject) => {
      const state: Pending = {
        started: false,
        bytes: 0,
        queued: 0,
        connector,
        release,
        controller:
          null as unknown as ReadableStreamDefaultController<Uint8Array>,
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          state.controller = controller;
        },
        pull: () => {
          if (state.queued > 0) {
            state.queued--;
            try {
              connector.send(JSON.stringify({ type: "http_ack", id }));
            } catch {}
          }
        },
        cancel: () => {
          clearTimeout(state.timer);
          try {
            connector.send(JSON.stringify({ type: "http_cancel", id }));
          } catch {}
          this.pending.delete(id);
          state.release?.();
        },
      });
      const abort = () => {
        this.pending.delete(id);
        try {
          connector.send(JSON.stringify({ type: "http_cancel", id }));
        } catch {}
        state.release?.();
        reject(new Error("request_cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, state);
      state.timer = setTimeout(() => {
        this.pending.delete(id);
        state.cleanup?.();
        state.release?.();
        state.reject?.(new Error("connector_timeout"));
      }, 30_000);
      state.resolve = resolve;
      state.reject = reject;
      state.cleanup = () => signal.removeEventListener("abort", abort);
      state.body = body;
    });
  }
  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const current = this.config;
    if (!current || Date.now() >= current.expiresAt) {
      await this.expire();
      return;
    }
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (attachment?.role === "connector") {
      if (this.connector() !== ws) return;
      if (typeof message !== "string" || message.length > 96 * 1024) {
        ws.close(1009, "message too large");
        return;
      }
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(message);
      } catch {
        ws.close(1003, "invalid frame");
        return;
      }
      const id = typeof frame.id === "string" ? frame.id : "";
      const item = this.pending.get(id);
      if (frame.type === "http_start" && item && !item.started) {
        const status = Number(frame.status);
        let headers: Headers;
        try {
          if (!Number.isInteger(status) || status < 200 || status > 599)
            throw new Error("invalid response status");
          headers = headersFromFrame(frame.headers);
        } catch {
          clearTimeout(item.timer);
          item.cleanup?.();
          item.reject?.(new Error("invalid local response"));
          this.pending.delete(id);
          item.release?.();
          return;
        }
        item.started = true;
        clearTimeout(item.timer);
        item.status = status;
        item.headers = headers;
        item.cleanup?.();
        item.resolve?.({
          status: item.status,
          headers: item.headers,
          body: item.body!,
        });
        item.timer = setTimeout(() => {
          try {
            item.connector?.send(JSON.stringify({ type: "http_cancel", id }));
          } catch {}
          item.controller.error(new Error("response_idle_timeout"));
          this.pending.delete(id);
          item.release?.();
        }, 60_000);
      } else if (frame.type === "http_chunk" && item?.started) {
        let bytes: Uint8Array;
        try {
          bytes = decodeB64(String(frame.data ?? ""));
        } catch {
          clearTimeout(item.timer);
          item.controller.error(new Error("invalid response body encoding"));
          this.pending.delete(id);
          item.release?.();
          return;
        }
        item.bytes += bytes.length;
        if (bytes.length > 32 * 1024 || item.bytes > current.maxBody) {
          clearTimeout(item.timer);
          item.controller.error(new Error("relay_body_limit"));
          this.pending.delete(id);
          item.release?.();
          return;
        }
        clearTimeout(item.timer);
        item.timer = setTimeout(() => {
          try {
            item.connector?.send(JSON.stringify({ type: "http_cancel", id }));
          } catch {}
          item.controller.error(new Error("response_idle_timeout"));
          this.pending.delete(id);
          item.release?.();
        }, 60_000);
        item.queued++;
        item.controller.enqueue(bytes);
      } else if (frame.type === "http_end" && item) {
        clearTimeout(item.timer);
        item.controller.close();
        this.pending.delete(id);
        item.release?.();
      } else if (frame.type === "http_error" && item) {
        clearTimeout(item.timer);
        item.cleanup?.();
        if (!item.started)
          item.reject?.(new Error(String(frame.error ?? "local_error")));
        else
          item.controller.error(
            new Error(String(frame.error ?? "local_error")),
          );
        this.pending.delete(id);
        item.release?.();
      } else if (frame.type === "ws_message") {
        const target = this.ctx.getWebSockets().find((socket) => {
          const a = socket.deserializeAttachment() as Attachment | null;
          return a?.role === "visitor" && a.wsId === id;
        });
        if (target?.readyState === WebSocket.OPEN) {
          const bytes = decodeB64(String(frame.data ?? ""));
          target.send(
            frame.text === true ? new TextDecoder().decode(bytes) : bytes,
          );
        }
      } else if (frame.type === "ws_close") {
        const target = this.ctx.getWebSockets().find((socket) => {
          const a = socket.deserializeAttachment() as Attachment | null;
          return a?.role === "visitor" && a.wsId === id;
        });
        target?.close(1000, "local closed");
      } else if (frame.type === "ws_opened") {
        const pending = this.pendingWs.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingWs.delete(id);
          const protocol = String(frame.protocol ?? "");
          pending.resolve(protocol);
        }
      } else if (frame.type === "ws_error") {
        const pending = this.pendingWs.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingWs.delete(id);
          pending.reject(new Error("local websocket failed"));
        }
        const target = this.ctx.getWebSockets().find((socket) => {
          const a = socket.deserializeAttachment() as Attachment | null;
          return a?.role === "visitor" && a.wsId === id;
        });
        target?.close(1011, "local websocket failed");
      }
    } else if (attachment?.role === "visitor") {
      const connector = this.connector();
      if (!connector) {
        ws.close(1011, "connector offline");
        return;
      }
      const frame =
        typeof message === "string"
          ? {
              type: "ws_message",
              id: attachment.wsId,
              data: encodeB64(new TextEncoder().encode(message)),
              text: true,
            }
          : {
              type: "ws_message",
              id: attachment.wsId,
              data: encodeB64(new Uint8Array(message)),
              text: false,
            };
      if (JSON.stringify(frame).length > 96 * 1024) {
        ws.close(1009, "message too large");
        return;
      }
      connector.send(JSON.stringify(frame));
    }
  }
  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (attachment?.role === "visitor") {
      const connector = this.connector();
      if (connector)
        connector.send(
          JSON.stringify({ type: "ws_close", id: attachment.wsId }),
        );
    }
    if (attachment?.role === "connector") {
      const successor = this.connector();
      if (successor && successor !== ws) return;
      for (const [id, item] of this.pending) {
        clearTimeout(item.timer);
        if (!item.started) item.reject?.(new Error("connector_disconnected"));
        else item.controller.error(new Error("connector_disconnected"));
        item.cleanup?.();
        item.release?.();
        this.pending.delete(id);
      }
      for (const [id, pending] of this.pendingWs) {
        clearTimeout(pending.timer);
        pending.reject(new Error("connector_disconnected"));
        this.pendingWs.delete(id);
      }
      for (const socket of this.ctx.getWebSockets()) {
        const a = socket.deserializeAttachment() as Attachment | null;
        if (a?.role === "visitor") socket.close(1011, "connector disconnected");
      }
    }
  }
  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
  async alarm(): Promise<void> {
    await this.expire();
  }
  private async expire(): Promise<void> {
    for (const waiter of this.httpQueue.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve({ response: json({ error: "tunnel_expired" }, 410) });
    }
    for (const ws of this.ctx.getWebSockets()) ws.close(1001, "tunnel expired");
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer);
      if (!item.started) item.reject?.(new Error("tunnel_expired"));
      else item.controller.error(new Error("tunnel_expired"));
      item.cleanup?.();
      item.release?.();
      this.pending.delete(id);
    }
    for (const [id, pending] of this.pendingWs) {
      clearTimeout(pending.timer);
      pending.reject(new Error("tunnel_expired"));
      this.pendingWs.delete(id);
    }
    this.ctx.storage.sql.exec("DELETE FROM tunnel");
    await this.ctx.storage.deleteAlarm();
  }
}

function encodeB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768)
    s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(s);
}
function decodeB64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
