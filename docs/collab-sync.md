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

## Open decisions

1. Worker domain: default `*.workers.dev` vs custom route on `lanescape`.
2. Enable-sync on an existing local project: keep Dexie copy as mirror
   (recommended) vs full migrate to cloud.
3. Confirm whole-doc LWW ceiling is acceptable for expected usage.
