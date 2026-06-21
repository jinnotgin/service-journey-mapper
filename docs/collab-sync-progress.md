# Collaborative Sync — Progress Log

Running log of work on the `collab-sync` branch. Newest entries at the top.
See `collab-sync.md` for the design.

## Status

- [x] **Phase 1 (backend)** — Worker skeleton + `POST /api/maps` + `GET /api/maps/:id` (HTTP) — verified locally
- [x] **Phase 1 (client)** — `?map=` init branch, "Enable sync" + Share UI, hydrate over HTTP — verified in browser
- [ ] **Phase 2** — WebSocket live updates (`doc.sync/update/reject`)
- [ ] **Phase 3** — Presence
- [ ] **Phase 4** — View vs edit links + rotate/disable
- [ ] **Phase 5** — (optional) password-gated links

## Log

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
