export type Frame = Record<string, unknown> & { type: string; id?: string };
export const CHUNK_BYTES = 48 * 1024;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_PENDING_BYTES = 1024 * 1024;

export function jsonFrame(ws: WebSocket, value: Frame): void {
  if (ws.readyState !== WebSocket.OPEN)
    throw new Error("connector unavailable");
  ws.send(JSON.stringify(value));
}

export function safeHeaders(input: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of input) {
    if (
      /^(host|connection|upgrade|content-length|transfer-encoding|authorization|cookie)$/i.test(
        key,
      )
    )
      continue;
    headers[key] = value;
  }
  return headers;
}

export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export async function matchesSecret(
  candidate: string,
  expectedHash: string,
): Promise<boolean> {
  const actual = await hashSecret(candidate);
  const encoder = new TextEncoder();
  const a = encoder.encode(actual);
  const b = encoder.encode(expectedHash);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return mismatch === 0;
}

export function randomSecret(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return btoa(String.fromCharCode(...data))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function encodeBase64(value: Uint8Array): string {
  let result = "";
  for (let i = 0; i < value.length; i += 0x8000)
    result += String.fromCharCode(...value.subarray(i, i + 0x8000));
  return btoa(result);
}
