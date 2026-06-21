// Small shared helpers: id/token generation, hashing, JSON responses, CORS.

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** URL-safe random id (not a secret), e.g. map id. */
export function randomId(len = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** High-entropy secret token (32 bytes, base64url). Shown to the user once. */
export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64url(bytes);
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 hex of a token; only the hash is ever stored. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time-ish string compare to avoid trivial timing leaks. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type Role = "owner" | "editor" | "viewer";

// ── HTTP helpers ──────────────────────────────────────────────────────

const LOCALHOST_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function corsHeaders(origin: string | null, allowed: Set<string>): Record<string, string> {
  // Any localhost origin is allowed for local dev; production origins must be
  // in the explicit allowlist.
  const ok = !!origin && (allowed.has(origin) || LOCALHOST_ORIGIN.test(origin));
  const allow = ok ? (origin as string) : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function json(body: unknown, init: ResponseInit = {}, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...extra, ...(init.headers || {}) },
  });
}

export function errorJson(status: number, message: string, extra: Record<string, string> = {}): Response {
  return json({ error: message }, { status }, extra);
}
