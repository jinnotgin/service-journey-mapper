# Collaborative Sync — Implementation Doc

Anonymous, public, link-based collaboration for Lanescape. Private by default;
"Enable sync" mints a cloud map; share via unguessable link.

## Guiding constraint

The app is **whole-document** today: every edit replaces the full `journeys`
array (`commitJourneys`, index.html) and autosave writes the whole blob to
IndexedDB. This design **preserves that model** and adds a thin sync layer on
top. No data-model rewrite, no per-entity IDs, no operation log.

Conflict policy = **whole-document last-write-wins (LWW)**, coordinated by a
single monotonic `version` integer per map, plus presence so people don't stomp
each other blindly. This is a deliberate MVP tradeoff: simultaneous edits to the
same map can clobber. If frequent concurrent editing of one map becomes a real
need, that is the signal to move to the heavier op-based/CRDT path — not before.

## Architecture

```
lanescape.pages.dev  (static index.html on Cloudflare Pages, unchanged deploy)
        |  fetch + WebSocket  (CORS-allowed)
        v
lanescape-sync.<acct>.workers.dev   (new wrangler Worker)
        | routes by mapId -> idFromName(mapId)
        v
Durable Object: MapRoom  (one per map, SQLite-backed storage)
```

Standalone Worker (not Pages Functions) so the Pages static deploy stays
untouched and Durable Object support is first-class. Cost: cross-origin, handled
with a small CORS allowlist (Pages origin + localhost).

## Repo layout

```
worker/
  wrangler.toml     # Worker name, MapRoom DO binding, SQLite migration
  src/index.ts      # Router: REST endpoints + WS upgrade -> DO
  src/MapRoom.ts     # Durable Object: storage, auth, broadcast
  package.json
  tsconfig.json
docs/
  collab-sync.md         # this file
  collab-sync-progress.md # running progress log
```

## REST API

| Method / path                       | Auth        | Purpose |
|-------------------------------------|-------------|---------|
| `POST /api/maps`                    | none        | Enable sync. Body `{ journeys, name }`. Mints `mapId` + owner/edit/view secrets. Returns secrets once. |
| `GET  /api/maps/:id?token=`         | any token   | Initial hydrate. Returns `{ doc, version, role, name }`. |
| `GET  /api/maps/:id/sync?token=`    | any token   | WebSocket upgrade -> DO live channel. |
| `POST /api/maps/:id/links`          | owner       | Create / rotate / disable view & edit links. |

All `/:id` routes resolve `env.MAP_ROOM.get(idFromName(id))` and forward; the DO
is the single source of truth and the auth boundary.

## Wire format (WebSocket)

Whole-document, versioned. `version` is one monotonic integer per map.

```
client -> server
  { t: "doc.push",        version, journeys }
  { t: "presence.update", clientId, name, color }

server -> client
  { t: "doc.sync",   version, journeys }   // on connect
  { t: "doc.update", version, journeys }   // a peer saved
  { t: "doc.reject", version, journeys }   // your push was stale; here is truth
  { t: "presence",   peers: [...] }
```

`doc.push` accept rule: if `version === currentVersion`, bump version, persist
snapshot, broadcast `doc.update` to *other* clients. Otherwise reply `doc.reject`
with the server's current doc so the client rebases (server wins = LWW).

## Durable Object: MapRoom

SQLite tables:

- `meta(mapId, name, version, createdAt, updatedAt)`
- `snapshot(version, json)`  — latest whole document
- `capabilities(role, tokenHash, enabled)` — owner/editor/viewer link hashes

Behavior:

- Auth: verify incoming `token` against stored SHA-256 hashes; assign connection
  a role (`owner` / `editor` / `viewer`). Viewers cannot push.
- WebSocket Hibernation API (`acceptWebSocket`) so idle maps cost nothing.
- Presence is broadcast, never persisted.

## Client integration points (index.html)

Wraps existing whole-document seams; no grid/cell/stage logic changes.

- New `useSync` hook: owns WebSocket, local `version`, reconnect/backoff, `role`,
  `peers`. Exposes `enableSync`, `pushDoc`, status.
- Routing: add `ROUTE_MAP_PARAM = "map"`; token stored in `localStorage`, not
  left in the URL after first use. Extend `writeRoute`.
- Init effect: add a `?map=` branch *before* the Dexie path — fetch
  `GET /api/maps/:id`, `replaceJourneys(hydrate(doc.journeys), {skipSave:true})`,
  set `viewOnly` when `role === 'viewer'` (mode already exists), open socket.
- Push: in the existing debounced autosave effect, also `pushDoc(...)` when synced.
- Apply remote: on `doc.sync/update/reject`, `replaceJourneys(..., {skipSave:true})`
  and adopt the version. Guard against clobbering the cell the local user is
  actively editing (defer until blur — same `document.activeElement` dance the
  popstate handler already uses).
- UI: "Share" button in the app-bar history cluster. Not-synced -> "Enable sync";
  synced -> copy link + presence avatar stack.

Undo/redo stays whole-snapshot (local). In a shared doc an undo is just the next
pushed version; it can revert a peer's concurrent change — accepted LWW tradeoff.

## Security & abuse

- Tokens: 32 random bytes; store only SHA-256 hashes in the DO. Raw token lives
  in the sharer's `localStorage`.
- CORS allowlist: Pages origin + localhost only.
- Rate-limit `POST /api/maps`.
- Document-size cap (~1-2 MB) on pushes to bound DO storage.

## Phasing

1. Worker skeleton + `POST /api/maps` + `GET /api/maps/:id` (HTTP round-trip first).
2. WebSocket live updates (`doc.sync/update/reject`), single editor role.
3. Presence (anonymous names + avatar stack).
4. View vs edit links + rotate / disable (owner UI).
5. (optional, later) password-gated links.
6. Stop sharing / delete cloud map (owner).
7. **Stable entity IDs** — prerequisite for everything below.
8. **Cell locking** — soft, presence-driven advisory locks (no data-model rewrite).
9. **Atomic operation-based sync** — per-cell content patches + structural ops
   (row add/delete/move, column add/delete, stage/sub-journey/journey ops).

See "Evolution: cell locking + atomic sync (Phases 7–9)" below for the design.

## Evolution: cell locking + atomic sync (Phases 7–9)

The whole-document LWW model above is the MVP. It clobbers concurrent edits and
re-sends the entire `journeys` array on every change. Phases 7–9 fix both
**without** adopting a CRDT, by combining two ideas that reinforce each other:

- A **per-cell lock** guarantees only one person edits a given cell at a time —
  which means we never need character-level text merge. Per-cell last-write-wins
  is sufficient *because the lock makes same-cell collisions impossible.*
- **Atomic ops** let the server reason about individual cells / rows / columns,
  so edits to *different* parts of the map stop conflicting and the wire payload
  shrinks from the whole doc to a single op.

### Phase 7 — Stable entity IDs (prerequisite)

Today cells/rows/sub-journeys/journeys are addressed **positionally**
(`jIdx/sjIdx/rowIdx/cellIdx`) and `hydrate()` assigns no IDs. You cannot lock or
patch "the cell at row 3" when a peer just deleted row 1. So first:

- Assign an immutable `id` (e.g. `crypto.randomUUID()`) to every **journey**,
  **stage** (and sub-stage / column leaf), **sub-journey**, **row**, and **cell**.
- **Backfill on load**: `hydrate()` mints IDs for any entity missing one, so old
  local/cloud docs upgrade transparently. IDs are persisted (Dexie + snapshot).
- All creation helpers (`newRow`, new cell, add stage/column, etc.) mint an `id`.
- IDs are opaque and stable for the entity's lifetime; reordering never changes
  an `id`. This is the only change in Phase 7 — no protocol change yet.

### Phase 8 — Cell locking (soft, advisory)

A lock is **presence**, not persistence: it rides in the socket attachment and is
broadcast like the roster, so it auto-releases on disconnect for free
(`webSocketClose` already re-broadcasts presence).

Nuances this must respect:

- **Lock on edit-intent, not on clicking around.** Acquire the lock on `focus` of
  a cell's editable surface (or first keystroke), *not* on mere `onSelect`. The
  client already separates selection from editing, so clicking around stays free.
- **No hoarding.** A lock carries a `lockedAt`; the editing client sends a
  **heartbeat** (~every 5 s) while active. A lock with no heartbeat for ~10–15 s
  is considered stale and ignored by peers / swept by the server.
- **Clean release** on `blur`, `Escape`, tab `visibilitychange → hidden`, and
  disconnect.
- **Enforcement.** Peers render a cell locked by someone else as read-only with
  the holder's color/initials. Hard enforcement (server rejecting a write to a
  cell locked by another socket) becomes possible once writes are per-cell in
  Phase 9; in Phase 8 the lock is advisory + UI-level.

Wire format additions:

```
client -> server
  { t: "lock.acquire",   cellId }
  { t: "lock.heartbeat", cellId }
  { t: "lock.release",   cellId }

server -> client
  { t: "locks", locks: [{ cellId, clientId, name, color, lockedAt }, ...] }
  { t: "lock.denied", cellId }     // someone already holds it
```

Phase 8 can ship on top of today's whole-doc sync and already removes the felt
clobbering, because the lock — not the data model — is what prevents two people
editing one cell.

### Phase 9 — Atomic operation-based sync

Replace the whole-`journeys` `doc.push` with granular ops applied **by id**. The
server still keeps a whole-document snapshot as its source of truth (hydrate and
storage stay simple, size still bounded); it just **applies ops to that snapshot
server-side** and broadcasts the single op instead of the whole blob.

Two op classes with different concurrency rules:

**A. Content ops — commutative, per-cell LWW, NOT globally version-gated.**
Different cells never conflict; the same cell is protected by the Phase 8 lock,
with a per-cell `rev`/timestamp as the LWW tiebreaker if a lock was missed.

```
{ t: "cell.set", cellId, fields: { html?, tags?, mode?, align? }, ts }
```

**B. Structural ops — serialized through the global `version`.** These reshape
the tree, so they are applied in order; a client that is behind gets a full
snapshot resync (`doc.reject`) rather than a risky positional rebase. Structural
edits are comparatively rare, so the occasional resync is acceptable.

Each structural op carries `baseVersion`; the server accepts iff
`baseVersion === currentVersion`, bumps the version, mutates the snapshot,
broadcasts the op (+ new version) to other clients, else replies `doc.reject`
with the current snapshot. Op set (keyed by **parent id**, never index):

```
Rows (within a sub-journey)
  { t: "row.insert", subJourneyId, afterRowId|null, row }   // row has a fresh id + cells
  { t: "row.delete", rowId }
  { t: "row.move",   rowId, afterRowId|null }
  { t: "row.setType", rowId, rowType }                      // normal / divider / section

Columns (stage leaves — span the whole journey, every row gains/loses a cell)
  { t: "column.insert", journeyId, stageId, afterColumnId|null }   // new cell id minted per row
  { t: "column.delete", journeyId, columnId }                      // drops that cell from every row
  { t: "column.move",   journeyId, columnId, afterColumnId|null }

Stages / sub-stages (the column header tree)
  { t: "stage.insert", journeyId, afterStageId|null, stage }
  { t: "stage.delete", journeyId, stageId }
  { t: "stage.move",   journeyId, stageId, afterStageId|null }
  { t: "stage.setLabel", stageId, label }
  ( sub-stage variants: substage.insert/delete/move/setLabel under a stageId )

Sub-journeys (row groups / lanes)
  { t: "subjourney.insert", journeyId, afterSubJourneyId|null, subJourney }
  { t: "subjourney.delete", subJourneyId }
  { t: "subjourney.move",   subJourneyId, afterSubJourneyId|null }
  { t: "subjourney.setLabel", subJourneyId, label }

Journeys (tabs)
  { t: "journey.insert", afterJourneyId|null, journey }
  { t: "journey.delete", journeyId }
  { t: "journey.move",   journeyId, afterJourneyId|null }
  { t: "journey.rename", journeyId, name }
```

**Column ops are journey-wide:** because columns are the leaves of the stage
tree and each row is normalized to `totalLeaves(stages)` cells,
`column.insert/delete` must add/remove the corresponding cell **in every row of
every sub-journey** of that journey (server reuses the existing
`normalizeRowCells` / `collapseDivider` logic, ported or mirrored). The op names
the affected `columnId` so the mutation is positional-free.

**Client mapping.** The existing immutable updaters are the natural emit points:
`editCell` → `cell.set`; `handleRowAction` (delete / insert / move / type) → the
`row.*` ops; the stage/column handlers → `stage.*` / `column.*`; tab add/delete/
rename → `journey.*`. Each updater applies locally (optimistic) **and** emits the
op; the inbound handler applies remote ops by id and skips the local-echo. The
`skipNextPushRef` echo-guard generalizes to an op-id/source guard.

**Undo/redo** stays a local whole-snapshot stack for now; an undo emits whatever
ops reconcile the snapshots (or, simplest first cut, a structural resync). This
can be refined later and is not a Phase 9 blocker.

**Fallback / safety.** Any op the server cannot apply cleanly (unknown id, failed
version gate, malformed) → it replies `doc.reject` with the full current
snapshot, so the client always converges. This guarantees correctness even if a
specific op path has a bug — the whole-doc resync is the backstop.

## Open decisions

1. Worker domain: default `*.workers.dev` vs custom route on `lanescape`.
2. Enable-sync on an existing local project: keep Dexie copy as mirror
   (recommended) vs full migrate to cloud.
3. Confirm whole-doc LWW ceiling is acceptable for expected usage.
