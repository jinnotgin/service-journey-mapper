# Collaborative Sync — Progress Log

Running log of work on the `collab-sync` branch. Newest entries at the top.
See `collab-sync.md` for the design.

## Status

- [x] **Phase 1 (backend)** — Worker skeleton + `POST /api/maps` + `GET /api/maps/:id` (HTTP) — verified locally
- [x] **Phase 1 (client)** — `?map=` init branch, "Enable sync" + Share UI, hydrate over HTTP — verified in browser
- [x] **Phase 2** — WebSocket live updates (`doc.sync/update/reject`) — verified locally (Worker + browser)
- [ ] **Phase 3** — Presence
- [ ] **Phase 4** — View vs edit links + rotate/disable
- [ ] **Phase 5** — (optional) password-gated links

## Log

### 2026-06-21 — Phase 2 done (WebSocket live channel)

Added the whole-document, last-write-wins live channel over WebSocket using the
Durable Object Hibernation API. No op-log, no CRDT, no per-entity IDs — every
accepted push replaces the full snapshot and bumps a single monotonic `version`.

Worker (`worker/`):

- `src/index.ts` — router now matches `GET /api/maps/:id/sync` with an
  `Upgrade: websocket` header and forwards the request (token in `?token=`)
  straight to the DO stub, returning its 101 response **as-is** (no CORS headers
  on a 101).
- `src/MapRoom.ts`:
  - Constructor now stores `this.state = state` (needed for `acceptWebSocket` /
    `getWebSockets`) alongside the existing `this.sql`.
  - `fetch` detects the `/sync` path + `Upgrade` header and calls new
    `handleSync(token)`: verifies the token via the existing `roleForToken`
    (403 as a normal Response if invalid), creates a `WebSocketPair`,
    `this.state.acceptWebSocket(server)`, persists the role with
    `server.serializeAttachment({ role })`, sends `doc.sync` immediately, and
    returns `new Response(null, { status: 101, webSocket: client })`.
  - `webSocketMessage` — handles only `doc.push`; reads role via
    `deserializeAttachment()` (viewers ignored); enforces the 2 MB cap; applies
    the LWW rule (accept iff `version === currentVersion`): on accept it inserts
    the new snapshot, prunes older snapshot rows, bumps `meta` version/updatedAt,
    and broadcasts `doc.update {version, journeys}` to every **other** socket via
    `this.state.getWebSockets()`; on stale it replies `doc.reject` (server's
    current doc) to the sender only.
  - `webSocketClose` / `webSocketError` implemented (no throw; role lives in the
    attachment so there is no in-memory state to clean up).
  - New `docMessage(t)` helper builds the `doc.sync/update/reject` envelope.
- `tsc --noEmit` passes.

Client (`index.html`, no grid/cell/stage logic touched):

- New refs in `App`: `wsRef` (open socket), `pendingRemoteRef` (deferred remote
  payload), `skipNextPushRef` (echo guard for the push effect).
- `applyRemoteDoc(parsed)` — adopts `parsed.version` into `syncVersionRef`, sets
  `skipNextPushRef`, and applies via `replaceJourneys(hydrate(...), {skipSave:true})`.
- `applyOrDeferRemote(parsed)` — if `document.activeElement` is a
  contentEditable/input/textarea, stash the payload and apply on the next blur
  (mirrors the popstate `document.activeElement?.blur` dance); otherwise apply
  immediately. Newest pending payload wins.
- WebSocket lifecycle effect keyed on `sync.status`/`sync.mapId`: opens
  `${SYNC_API_BASE.replace(/^http/,"ws")}/api/maps/:id/sync?token=` (token from
  `getMapToken`), routes `doc.sync/update/reject` to `applyOrDeferRemote`,
  reconnects with capped exponential backoff (1s→2s→4s… max 15s), and closes the
  socket on unmount / when leaving the map.
- Push effect keyed on `journeys`: when synced and role is owner/editor and the
  socket is OPEN, sends `{ t:"doc.push", version: syncVersionRef.current,
  journeys: journeysRef.current }`. It early-returns (consuming the flag) when
  `skipNextPushRef` is set, so a remote apply never echoes back. The existing
  Dexie autosave effect already early-returns on its own `skipNextSaveRef`, which
  `replaceJourneys({skipSave:true})` sets — so a remote apply neither re-saves
  nor re-pushes. `doc.reject` uses the same apply path, so the next push rebases
  on the fresh server version.

Verification (local: `wrangler dev --local` :8787 + static server :8755 +
throwaway Node `WebSocket` clients, now deleted):

- Server-side (two raw WS clients + HTTP hydrate), all assertions PASS:
  - A connects → `doc.sync` v1; B connects → `doc.sync` v1.
  - A pushes v1 (valid) → accepted, version→2; B receives `doc.update` v2 with
    A's content; A receives **no** echo of its own update.
  - A pushes v1 again (stale) → A receives `doc.reject` v2 with the server's
    current doc.
  - Viewer-token socket pushes → ignored; HTTP hydrate confirms version still 2
    with A's content.
- Client-side (real app in a browser preview):
  - "Enable sync" → URL becomes `?map=…`, owner token stored, socket opens.
  - Editing a grid cell (focus → input → blur) emits exactly one
    `doc.push {version, journeys}` frame (captured via a `WebSocket.send` patch).
  - A Node peer push (version=2 → server v3) arrives in the browser and is
    **applied** — the journey tab renders "PEER-PUSHED-TITLE" — and crucially the
    browser sends **zero** frames in response (no echo loop). HTTP hydrate
    confirms server at v3 with the peer's content. No console errors throughout.

Limitations / follow-ups:
- Active-edit guard defers a remote apply only while a field is focused; if the
  user keeps typing in *other* cells, later local pushes can still win/lose by
  LWW — that's the accepted whole-doc tradeoff, not a regression.
- No presence yet (Phase 3): the push effect treats every `journeys` change as a
  candidate push; there is no peer cursor/awareness.
- Snapshot pruning keeps only the latest row; there is no server-side history.
- `SYNC_API_BASE` prod value still has the placeholder subdomain
  (`lanescape-sync.YOUR-SUBDOMAIN.workers.dev`) — set after the Worker deploy.

### 2026-06-21 — Lengthen map id

- Map id bumped from `randomId(10)` to `randomId(24)` in `worker/src/index.ts`
  (~124 bits of entropy over the 36-char alphabet). The map id is the
  semi-public room identifier; access is still gated by capability tokens, but a
  longer id makes the room itself impractical to guess/enumerate.

### 2026-06-21 — Phase 1 client done

Decisions taken: keep local Dexie copy as a mirror; API base = default
`*.workers.dev` (config constant `SYNC_API_BASE` in index.html — paste the real
subdomain after first deploy).

Client changes in `index.html` (no grid/cell logic touched):

- Sync config + helpers block after `writeRoute`: `ROUTE_MAP_PARAM`,
  `SYNC_API_BASE` (localhost vs prod), `routeMapId`, `getMapToken`/`setMapToken`
  (token in localStorage, never left in URL), `writeMapRoute`, and the
  `apiCreateMap` / `apiGetMap` fetch wrappers.
- App state: `sync` ({mapId, role, status, error}) + `syncVersionRef`.
- `enableSync` callback: POST current journeys -> store owner token -> set
  synced -> switch URL to `?map=`.
- Init effect: new `?map=` branch before the Dexie path — consumes `?token=`
  into localStorage, strips it from the URL, hydrates from cloud, sets viewOnly
  for viewer role.
- `ShareControl` component + app-bar wiring: "Enable sync" -> "Share ▾" with
  copy edit/view link.
- Worker `corsHeaders` now also allows any `localhost`/`127.0.0.1` origin (dev).
- Fixed stale `.claude/static-server.js` (served old `service-journey-mapper.html`;
  now `index.html`).

Verified in browser (static server :8755 + `wrangler dev` :8787):

- open local project -> "Enable sync" -> OPTIONS 204 + POST 201; button becomes
  "Share ▾", URL -> `?map=m_...`, owner token in localStorage.
- reload with `?map=` -> GET 200 hydrate, opens straight into the synced project.
- open viewer link `?map=...&token=<viewer>` -> token consumed + stripped, app
  renders read-only (no edit/share controls). Screenshot confirms.
- no console errors throughout.

Known Phase 1 limitations (addressed later):
- Share menu only has edit/view tokens in memory right after enabling; after a
  reload it shows "Reopen to get links". Proper link surfacing/rotation = Phase 4.
- Edits are not yet pushed to the cloud (no `doc.push`); that's Phase 2 (WS) —
  for now autosave still writes the local Dexie mirror only.

### 2026-06-21 — Phase 1 backend done

Scaffolded `worker/` and built the REST backend:

- `worker/wrangler.toml` — `MapRoom` DO binding, `new_sqlite_classes` migration,
  `ALLOWED_ORIGINS` CORS var.
- `worker/src/util.ts` — id/secret generation, SHA-256 hashing, safe compare,
  CORS + JSON helpers.
- `worker/src/MapRoom.ts` — DO with SQLite tables (`meta`, `snapshot`,
  `capabilities`); internal `POST /init` and `GET /doc?token=` with role-based
  auth (owner/editor/viewer) and a 2 MB doc ceiling.
- `worker/src/index.ts` — router: `POST /api/maps` (mint map + 3 secrets,
  store only hashes) and `GET /api/maps/:id?token=` (hydrate), CORS preflight.

Verified via `wrangler dev --local` + curl:

- create map -> `{ mapId, version:1, tokens:{owner,editor,viewer} }` (201)
- owner/viewer hydrate -> correct `role` returned
- bad token -> 403; unknown map -> 404
- disallowed Origin -> no `Access-Control-Allow-Origin` echoed

`tsc --noEmit` passes.

Next: Phase 1 client — `useSync` hook, `?map=` init branch in index.html,
"Enable sync" button that POSTs the current journeys and swaps the URL to
`?map=`. Gated on open decision #1 (worker domain) for the production API base
URL; local dev uses `http://localhost:8787`.

### 2026-06-21 — Kickoff

- Created branch `collab-sync`.
- Wrote `docs/collab-sync.md` (design) and this progress log.
- Starting Phase 1: scaffold the `worker/` directory.
