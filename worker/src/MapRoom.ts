// Durable Object: one instance per map. Holds the whole-document snapshot, a
// monotonic version, and the capability (link token) hashes. Phase 1 implements
// storage + auth over an internal HTTP interface; Phase 2 adds the WebSocket
// live channel (whole-document, last-write-wins) using the Hibernation API.

import {
  Role,
  sha256Hex,
  safeEqual,
  randomSecret,
  hashPassword,
  verifyPassword,
} from "./util";
import { applyOp, isContentOp, Op } from "./ops";

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

// Body for the owner-only link-management endpoint (POST /links). Phase 5 adds
// the password-management actions (setPassword / clearPassword).
interface LinksBody {
  token?: string;
  action?: "get" | "rotate" | "setEnabled" | "setPassword" | "clearPassword";
  role?: "editor" | "viewer";
  enabled?: boolean;
  password?: string;
}

// Body for the public POST /access endpoint (Phase 5). A non-owner exchanges
// (link token + optional password) for a short-lived session token that the
// client then passes to hydrate (/doc) and the WS (/sync) as proof of the
// password factor. Owners bypass the password entirely.
interface AccessBody {
  token?: string;
  password?: string;
}

// Per-socket data persisted across hibernation via serializeAttachment.
// Presence fields (clientId/name/color) are ephemeral identity for the avatar
// stack — they live only here in the attachment, never in SQLite (Phase 3).
// Cell-lock fields (editingCellId/lockedAt) are the soft advisory lock a socket
// holds while editing one cell (Phase 8). A socket holds at most one lock.
interface SocketAttachment {
  role: Role;
  clientId?: string;
  name?: string;
  color?: string;
  editingCellId?: string;
  lockedAt?: number;
}

interface SaveMeta {
  updatedAt: number;
  updatedByClientId?: string;
  updatedByName?: string;
}

const MAX_DOC_BYTES = 2 * 1024 * 1024; // 2 MB ceiling per document
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // password sessions live 12 hours
const LOCK_TTL_MS = 15000; // a lock with no heartbeat for this long is stale (Phase 8)
const LOCK_SWEEP_MS = 5000; // alarm cadence while any lock is held (idle-hoarder sweep)

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
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        expires INTEGER NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket live channel (Phase 2). The router forwards
    // GET /api/maps/:id/sync here with the Upgrade header intact.
    if (url.pathname === "/sync" && request.headers.get("Upgrade") === "websocket") {
      return this.handleSync(url.searchParams.get("token"), url.searchParams.get("session"));
    }

    switch (`${request.method} ${url.pathname}`) {
      case "POST /init":
        return this.handleInit(await request.json());
      case "GET /doc":
        return this.handleGetDoc(url.searchParams.get("token"), url.searchParams.get("session"));
      case "POST /links":
        return this.handleLinks(await request.json());
      case "POST /access":
        return this.handleAccess(await request.json());
      case "POST /delete":
        return this.handleDelete(await request.json());
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  // ── WebSocket live channel (Hibernation API) ─────────────────────────

  private async handleSync(token: string | null, session: string | null): Promise<Response> {
    if (!this.getMeta("mapId")) {
      return new Response("Map not found", { status: 404 });
    }
    const role = await this.roleForToken(token);
    if (!role) {
      return new Response("Invalid token", { status: 403 });
    }
    // Password gate (Phase 5): when a password is set, non-owner sockets must
    // present a valid unexpired session (obtained from POST /access). Owners
    // bypass the password. Keeps the password out of the WS URL.
    if (role !== "owner" && this.passwordEnabled() && !(await this.validSession(session))) {
      return new Response("Password required", { status: 401 });
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
      baseVersion?: number;
      journeys?: unknown;
      clientId?: unknown;
      name?: unknown;
      color?: unknown;
      cellId?: unknown;
      ts?: unknown;
      // Phase 9 op fields are read generically via the parsed object.
      [k: string]: unknown;
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

    // Cell locking (Phase 8): soft advisory locks, a separate presence-like
    // channel layered on top of doc.* sync. Only owner/editor may lock — viewers
    // cannot edit, so their lock frames are ignored.
    if (msg.t === "lock.acquire" || msg.t === "lock.heartbeat" || msg.t === "lock.release") {
      if (role === "viewer") return;
      const cellId = typeof msg.cellId === "string" ? msg.cellId : undefined;
      if (!cellId) return;

      if (msg.t === "lock.acquire") {
        // Deny if a DIFFERENT live socket holds this cell with a fresh lock.
        const now = Date.now();
        for (const s of this.state.getWebSockets()) {
          if (s === ws) continue;
          const a = s.deserializeAttachment() as SocketAttachment | null;
          if (a?.editingCellId === cellId && a.lockedAt && now - a.lockedAt < LOCK_TTL_MS) {
            ws.send(JSON.stringify({ t: "lock.denied", cellId }));
            return;
          }
        }
        // Grant: take the lock (merge, preserving identity); a socket holds one lock.
        ws.serializeAttachment({ ...attachment, role, editingCellId: cellId, lockedAt: now });
        this.broadcastLocks();
        this.scheduleLockSweep();
        return;
      }

      if (msg.t === "lock.heartbeat") {
        // Refresh our own lock's freshness; no broadcast needed per heartbeat.
        if (attachment?.editingCellId === cellId) {
          ws.serializeAttachment({ ...attachment, role, editingCellId: cellId, lockedAt: Date.now() });
        }
        return;
      }

      // lock.release
      if (attachment?.editingCellId === cellId) {
        ws.serializeAttachment({ ...attachment, role, editingCellId: undefined, lockedAt: undefined });
        this.broadcastLocks();
      }
      return;
    }

    if (role === "viewer") return; // viewers cannot mutate (doc.push / ops alike)

    // ── Phase 9: atomic op-based sync ─────────────────────────────────────
    // The server keeps the whole-document snapshot as source of truth, applies
    // each op to it, and re-broadcasts the single op (not the whole blob).
    if (msg.t === "cell.set" || this.isStructuralOp(msg.t)) {
      this.handleOp(ws, msg as unknown as Op & { baseVersion?: number; ts?: number });
      return;
    }

    // ── Legacy whole-document push (Phase 2) ──────────────────────────────
    // Kept for protocol migration: a client still on the old whole-doc path can
    // share a map with new op-speaking clients and vice versa. Accept/reject by
    // the same LWW version gate, then broadcast as a structural full snapshot.
    if (msg.t !== "doc.push") return;

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
    const saveMeta = this.saveMetaFor(ws, now);
    this.persistSnapshot(journeys, newVersion, saveMeta);

    // Broadcast the accepted doc to every OTHER connected client.
    const update = JSON.stringify({ t: "doc.update", version: newVersion, journeys, ...saveMeta });
    this.broadcastExcept(ws, update);
    ws.send(JSON.stringify({ t: "doc.ack", version: newVersion, ...saveMeta }));
  }

  // ── Phase 9 op handling ─────────────────────────────────────────────────

  /** True for every structural op (those serialized through the global version). */
  private isStructuralOp(t: string | undefined): boolean {
    if (!t) return false;
    return (
      t.startsWith("row.") ||
      t.startsWith("column.") ||
      t.startsWith("stage.") ||
      t.startsWith("substage.") ||
      t.startsWith("subjourney.") ||
      t.startsWith("journey.")
    );
  }

  /**
   * Apply a single op to the snapshot and broadcast it. Two concurrency classes:
   *
   *  A. cell.set — content, NOT version-gated. Per-cell last-write-wins by `ts`:
   *     an incoming write older than the cell's last recorded `ts` is ignored.
   *     Different cells never conflict; the same cell is also protected by the
   *     Phase-8 lock, with `ts` as the backstop. Broadcast to OTHER clients.
   *
   *  B. structural — serialized through the global `version`. Carries
   *     `baseVersion`; accepted iff `baseVersion === currentVersion`, then the
   *     version bumps, the snapshot mutates, and the op (+ new version) is
   *     broadcast to OTHER clients. A stale base, an unknown id, or any op that
   *     `applyOp` cannot apply cleanly → reply `doc.reject` (full snapshot) to
   *     the sender so the stale client resyncs. This whole-doc resync is the
   *     universal convergence backstop.
   */
  private handleOp(ws: WebSocket, op: Op & { baseVersion?: number; ts?: number }): void {
    const currentVersion = Number(this.getMeta("version") || "1");
    const journeys = this.currentJourneys();
    const now = Date.now();

    if (isContentOp(op.t)) {
      // Per-cell LWW: ignore an out-of-order (older) write to the same cell.
      const cellId = typeof op.cellId === "string" ? op.cellId : null;
      const ts = typeof op.ts === "number" ? op.ts : now;
      if (!cellId) return;
      const tsMap = this.cellTsMap();
      const lastTs = tsMap[cellId] || 0;
      if (ts < lastTs) return; // stale write, drop silently
      const next = applyOp(journeys, op);
      if (!next) {
        // Unknown cell id (e.g. raced a structural delete) → resync.
        ws.send(JSON.stringify(this.docMessage("doc.reject")));
        return;
      }
      if (JSON.stringify(next).length > MAX_DOC_BYTES) {
        ws.send(JSON.stringify(this.docMessage("doc.reject")));
        return;
      }
      tsMap[cellId] = ts;
      this.setMeta("cellTs", JSON.stringify(tsMap));
      // cell.set does NOT bump the global version (content is commutative).
      const saveMeta = this.saveMetaFor(ws, now);
      this.persistSnapshot(next, currentVersion, saveMeta);
      const frame = JSON.stringify({ t: "cell.set", cellId, fields: op.fields, ts, ...saveMeta });
      this.broadcastExcept(ws, frame);
      ws.send(JSON.stringify({ t: "op.ack", op: op.t, version: currentVersion, ...saveMeta }));
      return;
    }

    // Structural op: version-gated.
    if (Number(op.baseVersion) !== currentVersion) {
      ws.send(JSON.stringify(this.docMessage("doc.reject")));
      return;
    }
    const next = applyOp(journeys, op);
    if (!next) {
      // Unknown id / malformed / un-special-cased → full resync (the backstop).
      ws.send(JSON.stringify(this.docMessage("doc.reject")));
      return;
    }
    const docJson = JSON.stringify(next);
    if (docJson.length > MAX_DOC_BYTES) {
      ws.send(JSON.stringify(this.docMessage("doc.reject")));
      return;
    }
    const newVersion = currentVersion + 1;
    const saveMeta = this.saveMetaFor(ws, now);
    this.persistSnapshot(next, newVersion, saveMeta);
    // Re-broadcast the op (+ the new version) to OTHER clients. They apply it by
    // id to their local journeys and adopt `version`.
    const frame = JSON.stringify({ ...op, version: newVersion, ...saveMeta });
    this.broadcastExcept(ws, frame);
    ws.send(JSON.stringify({ t: "op.ack", op: op.t, version: newVersion, ...saveMeta }));
  }

  /** The current whole-document snapshot as a parsed journeys array. */
  private currentJourneys(): unknown[] {
    const version = Number(this.getMeta("version") || "1");
    const row = this.sql.exec("SELECT json FROM snapshot WHERE version = ?", version).toArray()[0];
    return row ? (JSON.parse(row.json as string) as unknown[]) : [];
  }

  /** Persist a snapshot at `version` (prune older rows) and bump updatedAt. */
  private persistSnapshot(journeys: unknown, version: number, saveMeta: SaveMeta): void {
    const docJson = JSON.stringify(journeys);
    this.sql.exec(
      "INSERT INTO snapshot (version, json) VALUES (?, ?) ON CONFLICT(version) DO UPDATE SET json = excluded.json",
      version,
      docJson,
    );
    this.sql.exec("DELETE FROM snapshot WHERE version <> ?", version);
    this.setMeta("version", String(version));
    this.setMeta("updatedAt", String(saveMeta.updatedAt));
    if (saveMeta.updatedByClientId) this.setMeta("updatedByClientId", saveMeta.updatedByClientId);
    if (saveMeta.updatedByName) this.setMeta("updatedByName", saveMeta.updatedByName);
  }

  private saveMetaFor(ws: WebSocket, updatedAt: number): SaveMeta {
    const a = ws.deserializeAttachment() as SocketAttachment | null;
    return {
      updatedAt,
      updatedByClientId: a?.clientId,
      updatedByName: a?.name || "Someone",
    };
  }

  /** Per-cell last-write timestamps for cell.set LWW (stored as one meta blob). */
  private cellTsMap(): Record<string, number> {
    const raw = this.getMeta("cellTs");
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  /** Send a frame to every connected socket except `ws`. */
  private broadcastExcept(ws: WebSocket, frame: string): void {
    for (const peer of this.state.getWebSockets()) {
      if (peer === ws) continue;
      try {
        peer.send(frame);
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
    // Its lock dies with its attachment, so refresh the lock roster too (Phase 8).
    this.broadcastPresence(ws);
    this.broadcastLocks(ws);
  }

  async webSocketError(ws: WebSocket, _err: unknown): Promise<void> {
    // Presence + locks live in the attachment; refresh both rosters for the peers
    // (excluding the failing socket, which may still appear in getWebSockets()).
    this.broadcastPresence(ws);
    this.broadcastLocks(ws);
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

  /**
   * Build and broadcast the current cell-lock roster (Phase 8). Mirrors
   * broadcastPresence: reads each socket's attachment, includes only locks that
   * are fresh (lockedAt within LOCK_TTL_MS) and have a clientId, and sends the
   * full list to EVERY socket (holder included — clients filter their own
   * clientId so their own lock never locks them out). `except` skips one socket,
   * used on close/error so a departing socket's lock is not counted.
   */
  private broadcastLocks(except?: WebSocket): void {
    const sockets = this.state.getWebSockets();
    const now = Date.now();
    const locks: Array<{
      cellId: string;
      clientId: string;
      name?: string;
      color?: string;
      lockedAt: number;
    }> = [];
    for (const s of sockets) {
      if (s === except) continue;
      const a = s.deserializeAttachment() as SocketAttachment | null;
      if (!a || !a.editingCellId || !a.clientId || !a.lockedAt) continue;
      if (now - a.lockedAt >= LOCK_TTL_MS) continue; // stale; ignore
      locks.push({
        cellId: a.editingCellId,
        clientId: a.clientId,
        name: a.name,
        color: a.color,
        lockedAt: a.lockedAt,
      });
    }
    const frame = JSON.stringify({ t: "locks", locks });
    for (const s of sockets) {
      if (s === except) continue;
      try {
        s.send(frame);
      } catch {
        /* peer going away; ignore */
      }
    }
  }

  /**
   * Schedule the idle-hoarder sweep (Phase 8). With no socket events nothing
   * re-broadcasts, so a lock whose holder keeps the socket open but stops
   * heartbeating would linger visually forever. A DO alarm sweeps stale locks
   * within ~TTL even with zero other activity.
   */
  private scheduleLockSweep(): void {
    // Only schedule if not already pending (cheap; setAlarm overwrites anyway).
    this.state.storage.setAlarm(Date.now() + LOCK_SWEEP_MS);
  }

  /**
   * Alarm handler (Phase 8): drop any stale locks (clear editingCellId/lockedAt
   * on those sockets), re-broadcast the roster, and reschedule while any FRESH
   * lock remains so an idle-hoarder lock demonstrably expires.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    let changed = false;
    let freshRemains = false;
    for (const s of this.state.getWebSockets()) {
      const a = s.deserializeAttachment() as SocketAttachment | null;
      if (!a || !a.editingCellId || !a.lockedAt) continue;
      if (now - a.lockedAt >= LOCK_TTL_MS) {
        s.serializeAttachment({ ...a, editingCellId: undefined, lockedAt: undefined });
        changed = true;
      } else {
        freshRemains = true;
      }
    }
    if (changed) this.broadcastLocks();
    if (freshRemains) this.scheduleLockSweep();
  }

  /** Build a doc.sync / doc.update / doc.reject envelope from current state. */
  private docMessage(t: "doc.sync" | "doc.update" | "doc.reject"): {
    t: string;
    version: number;
    journeys: unknown;
    updatedAt: number | null;
    updatedByClientId: string | null;
    updatedByName: string | null;
  } {
    const version = Number(this.getMeta("version") || "1");
    const row = this.sql.exec("SELECT json FROM snapshot WHERE version = ?", version).toArray()[0];
    const journeys = row ? JSON.parse(row.json as string) : [];
    return {
      t,
      version,
      journeys,
      updatedAt: this.numberMeta("updatedAt"),
      updatedByClientId: this.getMeta("updatedByClientId"),
      updatedByName: this.getMeta("updatedByName"),
    };
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
    this.setMeta("updatedByName", "Owner");
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

  private async handleGetDoc(token: string | null, session: string | null): Promise<Response> {
    if (!this.getMeta("mapId")) {
      return new Response(JSON.stringify({ error: "Map not found" }), { status: 404 });
    }
    const role = await this.roleForToken(token);
    if (!role) {
      return new Response(JSON.stringify({ error: "Invalid token" }), { status: 403 });
    }
    // Password gate (Phase 5): when a password is set, a non-owner must present a
    // valid session (from POST /access) in addition to the link token. 401 so the
    // client knows to prompt for the password rather than treating it as a dead link.
    if (role !== "owner" && this.passwordEnabled() && !(await this.validSession(session))) {
      return new Response(JSON.stringify({ error: "Password required", passwordRequired: true }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const version = Number(this.getMeta("version") || "1");
    const row = this.sql.exec("SELECT json FROM snapshot WHERE version = ?", version).one();
    return new Response(
      JSON.stringify({
        journeys: JSON.parse(row.json as string),
        version,
        role,
        name: this.getMeta("name"),
        updatedAt: this.numberMeta("updatedAt"),
        updatedByClientId: this.getMeta("updatedByClientId"),
        updatedByName: this.getMeta("updatedByName"),
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
    } else if (action === "setPassword") {
      // Phase 5: set/change the map password. Only the salted PBKDF2 hash + salt
      // are stored; the raw password is never persisted. Existing sessions are
      // invalidated so a password change re-locks open links on reconnect/hydrate.
      const password = typeof body.password === "string" ? body.password : "";
      if (!password) {
        return new Response(JSON.stringify({ error: "Password required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const { hashHex, saltHex } = await hashPassword(password);
      this.setMeta("pw:hash", hashHex);
      this.setMeta("pw:salt", saltHex);
      this.setMeta("pw:enabled", "1");
      this.sql.exec("DELETE FROM sessions");
    } else if (action === "clearPassword") {
      // Phase 5: remove the password; links open without a prompt again.
      this.sql.exec("DELETE FROM meta WHERE k IN ('pw:hash', 'pw:salt', 'pw:enabled')");
      this.sql.exec("DELETE FROM sessions");
    }

    // Every action returns the current state of both links + password status.
    return new Response(
      JSON.stringify({ links: this.readLinks(), passwordEnabled: this.passwordEnabled() }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // ── public password gate (Phase 5) ───────────────────────────────────

  /**
   * Exchange (link token + optional password) for access. Owners and
   * password-disabled maps need no password. When a password IS enabled and the
   * supplied one is correct, mint a short-lived session token (12h) the client
   * passes to /doc and /sync. Wrong/missing password → 401 { passwordRequired }.
   */
  private async handleAccess(body: AccessBody): Promise<Response> {
    if (!this.getMeta("mapId")) {
      return new Response(JSON.stringify({ error: "Map not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const role = await this.roleForToken(body.token ?? null);
    if (!role) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Owner or no password set → access granted, no session needed.
    if (role === "owner" || !this.passwordEnabled()) {
      return new Response(JSON.stringify({ ok: true, role, passwordRequired: false }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Password enabled: verify it. Reveal nothing beyond "password required".
    const password = typeof body.password === "string" ? body.password : "";
    const saltHex = this.getMeta("pw:salt");
    const hashHex = this.getMeta("pw:hash");
    const ok = !!password && !!saltHex && !!hashHex && (await verifyPassword(password, saltHex, hashHex));
    if (!ok) {
      return new Response(JSON.stringify({ ok: false, passwordRequired: true }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Correct: mint a session. Only the session hash is stored (treat like a token).
    const session = randomSecret();
    const sessionHash = await sha256Hex(session);
    const expires = Date.now() + SESSION_TTL_MS;
    this.sql.exec("DELETE FROM sessions WHERE expires < ?", Date.now()); // opportunistic GC
    this.sql.exec(
      "INSERT INTO sessions (token_hash, expires) VALUES (?, ?) ON CONFLICT(token_hash) DO UPDATE SET expires = excluded.expires",
      sessionHash,
      expires,
    );
    return new Response(
      JSON.stringify({ ok: true, role, passwordRequired: false, session, expires }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // ── owner delete ─────────────────────────────────────────────────────

  /** Owner-only: permanently wipe all map data and kick connected WebSockets. */
  private async handleDelete(body: { token?: string }): Promise<Response> {
    const role = await this.roleForToken(body.token ?? null);
    if (role !== "owner") {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Close all live WebSocket connections so peers get an immediate disconnect.
    for (const ws of this.state.getWebSockets()) {
      try { ws.close(4001, "Map deleted"); } catch { /* ignore */ }
    }

    // Wipe all stored data. mapId will be absent → future GET/WS requests 404.
    this.sql.exec("DELETE FROM meta");
    this.sql.exec("DELETE FROM snapshot");
    this.sql.exec("DELETE FROM capabilities");
    this.sql.exec("DELETE FROM sessions");

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /** True if this map currently requires a password. */
  private passwordEnabled(): boolean {
    return this.getMeta("pw:enabled") === "1";
  }

  /** Validate a (raw) session token against the unexpired sessions table. */
  private async validSession(session: string | null): Promise<boolean> {
    if (!session) return false;
    const hash = await sha256Hex(session);
    const row = this.sql
      .exec("SELECT expires FROM sessions WHERE token_hash = ?", hash)
      .toArray()[0];
    if (!row) return false;
    if (Number(row.expires) < Date.now()) {
      this.sql.exec("DELETE FROM sessions WHERE token_hash = ?", hash);
      return false;
    }
    return true;
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

  private numberMeta(k: string): number | null {
    const raw = this.getMeta(k);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  private setMeta(k: string, v: string): void {
    this.sql.exec(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      k,
      v,
    );
  }
}
