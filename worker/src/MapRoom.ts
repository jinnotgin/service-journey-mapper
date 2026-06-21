// Durable Object: one instance per map. Holds the whole-document snapshot, a
// monotonic version, and the capability (link token) hashes. Phase 1 implements
// storage + auth over an internal HTTP interface; Phase 2 adds the WebSocket
// live channel (whole-document, last-write-wins) using the Hibernation API.

import { Role, sha256Hex, safeEqual, randomSecret } from "./util";

interface InitBody {
  mapId: string;
  name: string;
  journeys: unknown[];
  tokenHashes: { owner: string; editor: string; viewer: string };
  // Raw editor/viewer share secrets. SECURITY TRADE-OFF (Phase 4): unlike the
  // owner key (hash-only), the editor/viewer tokens are stored raw in `meta` so
  // the owner can re-read and copy the share links after a reload, and so
  // "rotate" can replace them. These are share secrets the owner is entitled to
  // see; the owner key itself is never stored raw. Pragmatic choice for an
  // anonymous-collaboration MVP — see docs/collab-sync.md / progress log.
  shareTokens: { editor: string; viewer: string };
}

// Body for the owner-only link-management endpoint (POST /links).
interface LinksBody {
  token?: string;
  action?: "get" | "rotate" | "setEnabled";
  role?: "editor" | "viewer";
  enabled?: boolean;
}

// Per-socket data persisted across hibernation via serializeAttachment.
// Presence fields (clientId/name/color) are ephemeral identity for the avatar
// stack — they live only here in the attachment, never in SQLite (Phase 3).
interface SocketAttachment {
  role: Role;
  clientId?: string;
  name?: string;
  color?: string;
}

const MAX_DOC_BYTES = 2 * 1024 * 1024; // 2 MB ceiling per document

export class MapRoom {
  private state: DurableObjectState;
  private sql: SqlStorage;

  constructor(state: DurableObjectState) {
    this.state = state;
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

    // WebSocket live channel (Phase 2). The router forwards
    // GET /api/maps/:id/sync here with the Upgrade header intact.
    if (url.pathname === "/sync" && request.headers.get("Upgrade") === "websocket") {
      return this.handleSync(url.searchParams.get("token"));
    }

    switch (`${request.method} ${url.pathname}`) {
      case "POST /init":
        return this.handleInit(await request.json());
      case "GET /doc":
        return this.handleGetDoc(url.searchParams.get("token"));
      case "POST /links":
        return this.handleLinks(await request.json());
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  // ── WebSocket live channel (Hibernation API) ─────────────────────────

  private async handleSync(token: string | null): Promise<Response> {
    if (!this.getMeta("mapId")) {
      return new Response("Map not found", { status: 404 });
    }
    const role = await this.roleForToken(token);
    if (!role) {
      return new Response("Invalid token", { status: 403 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Accept with the Hibernation API so an idle map costs nothing.
    this.state.acceptWebSocket(server);
    // Persist the role so it survives hibernation (no in-memory map).
    server.serializeAttachment({ role } satisfies SocketAttachment);

    // Send the current document immediately on connect.
    server.send(JSON.stringify(this.docMessage("doc.sync")));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let msg: {
      t?: string;
      version?: number;
      journeys?: unknown;
      clientId?: unknown;
      name?: unknown;
      color?: unknown;
    };
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return; // ignore malformed frames
    }
    if (!msg) return;

    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    const role = attachment?.role;
    if (!role) return; // socket has no role yet; ignore

    // Presence (Phase 3): ephemeral identity for the avatar stack. Allowed for
    // every role (viewers are present too); stored only in the attachment.
    if (msg.t === "presence.update") {
      const clientId = typeof msg.clientId === "string" ? msg.clientId : undefined;
      if (!clientId) return; // need a stable id to roster
      const next: SocketAttachment = {
        role,
        clientId,
        name: typeof msg.name === "string" ? msg.name.slice(0, 80) : undefined,
        color: typeof msg.color === "string" ? msg.color.slice(0, 32) : undefined,
      };
      ws.serializeAttachment(next);
      this.broadcastPresence();
      return;
    }

    if (msg.t !== "doc.push") return; // only doc.push / presence.update handled
    if (role === "viewer") return; // viewers cannot mutate

    const journeys = Array.isArray(msg.journeys) ? msg.journeys : [];
    const docJson = JSON.stringify(journeys);
    if (docJson.length > MAX_DOC_BYTES) return; // bound DO storage

    const currentVersion = Number(this.getMeta("version") || "1");

    // Whole-document LWW: accept only if the pusher is on the current version.
    if (Number(msg.version) !== currentVersion) {
      // Stale push: reply to the sender only with the server's truth.
      ws.send(JSON.stringify(this.docMessage("doc.reject")));
      return;
    }

    const newVersion = currentVersion + 1;
    const now = Date.now();
    this.sql.exec("INSERT INTO snapshot (version, json) VALUES (?, ?)", newVersion, docJson);
    // Keep only the latest snapshot to bound storage.
    this.sql.exec("DELETE FROM snapshot WHERE version <> ?", newVersion);
    this.setMeta("version", String(newVersion));
    this.setMeta("updatedAt", String(now));

    // Broadcast the accepted doc to every OTHER connected client.
    const update = JSON.stringify({ t: "doc.update", version: newVersion, journeys });
    for (const peer of this.state.getWebSockets()) {
      if (peer === ws) continue;
      try {
        peer.send(update);
      } catch {
        /* peer going away; ignore */
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    try {
      ws.close(code, "closing");
    } catch {
      /* already closed */
    }
    // Tell remaining peers this socket has left (exclude the departing one).
    this.broadcastPresence(ws);
  }

  async webSocketError(ws: WebSocket, _err: unknown): Promise<void> {
    // Presence lives in the attachment; just refresh the roster for the peers
    // (excluding the failing socket, which may still appear in getWebSockets()).
    this.broadcastPresence(ws);
  }

  /**
   * Build and broadcast the current presence roster (Phase 3). Reads each
   * socket's attachment, includes only those that have announced a clientId,
   * and sends the full roster to every socket (clients filter out their own
   * clientId). `except` skips one socket — used on close/error so a departing
   * socket is not counted even if it still lingers in getWebSockets().
   */
  private broadcastPresence(except?: WebSocket): void {
    const sockets = this.state.getWebSockets();
    const peers: Array<{ clientId: string; name?: string; color?: string }> = [];
    for (const s of sockets) {
      if (s === except) continue;
      const a = s.deserializeAttachment() as SocketAttachment | null;
      if (!a || !a.clientId) continue;
      peers.push({ clientId: a.clientId, name: a.name, color: a.color });
    }
    const frame = JSON.stringify({ t: "presence", peers });
    for (const s of sockets) {
      if (s === except) continue;
      try {
        s.send(frame);
      } catch {
        /* peer going away; ignore */
      }
    }
  }

  /** Build a doc.sync / doc.update / doc.reject envelope from current state. */
  private docMessage(t: "doc.sync" | "doc.update" | "doc.reject"): {
    t: string;
    version: number;
    journeys: unknown;
  } {
    const version = Number(this.getMeta("version") || "1");
    const row = this.sql.exec("SELECT json FROM snapshot WHERE version = ?", version).toArray()[0];
    const journeys = row ? JSON.parse(row.json as string) : [];
    return { t, version, journeys };
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
    // Store the raw editor/viewer share tokens so the owner can retrieve/copy
    // the share links after a reload and so rotate can replace them. The owner
    // raw token is deliberately NOT stored (hash-only). See the InitBody comment.
    if (body.shareTokens) {
      this.setMeta("token:editor", body.shareTokens.editor);
      this.setMeta("token:viewer", body.shareTokens.viewer);
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

  // ── owner-only link management (Phase 4) ─────────────────────────────

  /**
   * Manage the editor/viewer share links. Owner-only: the caller must present
   * the owner token. Actions:
   *   - "get":        return both links { editor:{token,enabled}, viewer:{...} }
   *   - "rotate":     mint a new secret for `role`, replace the stored raw token
   *                   and its capability hash, force enabled=1. Old link dies.
   *   - "setEnabled": flip capabilities.enabled for `role` (0/1). A disabled
   *                   token is rejected by roleForToken (WHERE enabled = 1).
   * NOTE: rotating/disabling does not force-disconnect currently-connected
   * editor/viewer WebSockets; they keep their session until they reconnect, at
   * which point the new auth rules apply. Acceptable for the MVP.
   */
  private async handleLinks(body: LinksBody): Promise<Response> {
    if (!this.getMeta("mapId")) {
      return new Response(JSON.stringify({ error: "Map not found" }), { status: 404 });
    }
    // Owner-only gate: verify the presented token resolves to the owner role.
    const role = await this.roleForToken(body.token ?? null);
    if (role !== "owner") {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    const action = body.action;
    if (action === "rotate" || action === "setEnabled") {
      const target = body.role;
      if (target !== "editor" && target !== "viewer") {
        return new Response(JSON.stringify({ error: "Invalid role" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (action === "rotate") {
        const fresh = randomSecret();
        const hash = await sha256Hex(fresh);
        this.setMeta(`token:${target}`, fresh);
        this.sql.exec(
          "UPDATE capabilities SET token_hash = ?, enabled = 1 WHERE role = ?",
          hash,
          target,
        );
      } else {
        this.sql.exec(
          "UPDATE capabilities SET enabled = ? WHERE role = ?",
          body.enabled ? 1 : 0,
          target,
        );
      }
    }

    // Every action returns the current state of both links.
    return new Response(JSON.stringify({ links: this.readLinks() }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /** Read the editor/viewer raw tokens + enabled flags for the owner UI. */
  private readLinks(): {
    editor: { token: string | null; enabled: boolean };
    viewer: { token: string | null; enabled: boolean };
  } {
    const enabledFor = (role: "editor" | "viewer"): boolean => {
      const row = this.sql
        .exec("SELECT enabled FROM capabilities WHERE role = ?", role)
        .toArray()[0];
      return row ? Number(row.enabled) === 1 : false;
    };
    return {
      editor: { token: this.getMeta("token:editor"), enabled: enabledFor("editor") },
      viewer: { token: this.getMeta("token:viewer"), enabled: enabledFor("viewer") },
    };
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
