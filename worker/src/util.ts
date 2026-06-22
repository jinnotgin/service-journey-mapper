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

// ── Password hashing (Phase 5: optional password-gated share links) ────
// Salted PBKDF2-SHA256. Only the salt + derived hash are ever stored; the raw
// password is never persisted. The optional map password is a second knowledge
// factor on top of the possession factor (the link token).

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_BITS = 256; // 32-byte derived key

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Derive a PBKDF2-SHA256 hash of a password. If `saltHex` is omitted a fresh
 * random 16-byte salt is generated. Returns hex-encoded salt + hash.
 */
export async function hashPassword(
  password: string,
  saltHex?: string,
): Promise<{ hashHex: string; saltHex: string }> {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    PBKDF2_KEY_BITS,
  );
  return { hashHex: bytesToHex(new Uint8Array(bits)), saltHex: bytesToHex(salt) };
}

/** Verify a password against a stored salt + hash using a constant-time compare. */
export async function verifyPassword(
  password: string,
  saltHex: string,
  hashHex: string,
): Promise<boolean> {
  const { hashHex: candidate } = await hashPassword(password, saltHex);
  return safeEqual(candidate, hashHex);
}

export type Role = "owner" | "editor" | "viewer";

// ── HTTP helpers ──────────────────────────────────────────────────────

const LOCALHOST_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function corsHeaders(origin: string | null, allowed: Set<string>): Record<string, string> {
  // Exact entries: match literally. Wildcard entries (*.example.com) match any
  // subdomain of that host — covers Cloudflare Pages preview URLs like
  // <hash>.lanescape.pages.dev which can't be pre-enumerated.
  const wildcardSuffixes = [...allowed]
    .filter((s) => s.startsWith("*."))
    .map((s) => s.slice(1)); // "*.lanescape.pages.dev" -> ".lanescape.pages.dev"
  const ok =
    !!origin &&
    (allowed.has(origin) ||
      LOCALHOST_ORIGIN.test(origin) ||
      wildcardSuffixes.some((suffix) => origin.endsWith(suffix)));
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
