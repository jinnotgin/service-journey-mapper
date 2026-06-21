// Durable Object: one instance per map. Holds the whole-document snapshot, a
// monotonic version, and the capability (link token) hashes. Phase 1 implements
// storage + auth over an internal HTTP interface; Phase 2 adds the WebSocket
// live channel.

import { Role, sha256Hex, safeEqual } from "./util";

interface InitBody {
  mapId: string;
  name: string;
  journeys: unknown[];
  tokenHashes: { owner: string; editor: string; viewer: string };
}

const MAX_DOC_BYTES = 2 * 1024 * 1024; // 2 MB ceiling per document

export class MapRoom {
  private sql: SqlStorage;

  constructor(state: DurableObjectState) {
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT
      );
      CREATE TABLE IF NOT EXISTS snapshot (
        version INTEGER PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capabilities (
        role TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (`${request.method} ${url.pathname}`) {
      case "POST /init":
        return this.handleInit(await request.json());
      case "GET /doc":
        return this.handleGetDoc(url.searchParams.get("token"));
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  // ── internal endpoints ───────────────────────────────────────────────

  private async handleInit(body: InitBody): Promise<Response> {
    if (this.getMeta("mapId")) {
      return new Response(JSON.stringify({ error: "Map already exists" }), { status: 409 });
    }
    const journeys = Array.isArray(body.journeys) ? body.journeys : [];
    const docJson = JSON.stringify(journeys);
    if (docJson.length > MAX_DOC_BYTES) {
      return new Response(JSON.stringify({ error: "Document too large" }), { status: 413 });
    }
    const now = Date.now();
    this.setMeta("mapId", body.mapId);
    this.setMeta("name", body.name || "Untitled");
    this.setMeta("version", "1");
    this.setMeta("createdAt", String(now));
    this.setMeta("updatedAt", String(now));
    this.sql.exec("INSERT INTO snapshot (version, json) VALUES (?, ?)", 1, docJson);
    for (const role of ["owner", "editor", "viewer"] as const) {
      this.sql.exec(
        "INSERT INTO capabilities (role, token_hash, enabled) VALUES (?, ?, 1)",
        role,
        body.tokenHashes[role],
      );
    }
    return new Response(JSON.stringify({ ok: true, version: 1 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleGetDoc(token: string | null): Promise<Response> {
    if (!this.getMeta("mapId")) {
      return new Response(JSON.stringify({ error: "Map not found" }), { status: 404 });
    }
    const role = await this.roleForToken(token);
    if (!role) {
      return new Response(JSON.stringify({ error: "Invalid token" }), { status: 403 });
    }
    const version = Number(this.getMeta("version") || "1");
    const row = this.sql.exec("SELECT json FROM snapshot WHERE version = ?", version).one();
    return new Response(
      JSON.stringify({
        journeys: JSON.parse(row.json as string),
        version,
        role,
        name: this.getMeta("name"),
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // ── helpers ──────────────────────────────────────────────────────────

  /** Returns the role a token grants, or null. Owner > editor > viewer. */
  private async roleForToken(token: string | null): Promise<Role | null> {
    if (!token) return null;
    const hash = await sha256Hex(token);
    const rows = this.sql
      .exec("SELECT role, token_hash FROM capabilities WHERE enabled = 1")
      .toArray();
    for (const r of rows) {
      if (safeEqual(hash, r.token_hash as string)) return r.role as Role;
    }
    return null;
  }

  private getMeta(k: string): string | null {
    const row = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0];
    return row ? (row.v as string) : null;
  }

  private setMeta(k: string, v: string): void {
    this.sql.exec(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      k,
      v,
    );
  }
}
