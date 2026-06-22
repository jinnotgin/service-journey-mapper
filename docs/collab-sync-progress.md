# Collaborative Sync — Progress Log

Running log of work on the `collab-sync` branch. Newest entries at the top.
See `collab-sync.md` for the design.

## Status

- [x] **Phase 1 (backend)** — Worker skeleton + `POST /api/maps` + `GET /api/maps/:id` (HTTP) — verified locally
- [x] **Phase 1 (client)** — `?map=` init branch, "Enable sync" + Share UI, hydrate over HTTP — verified in browser
- [x] **Phase 2** — WebSocket live updates (`doc.sync/update/reject`) — verified locally (Worker + browser)
- [x] **Phase 3** — Presence (anonymous names + avatar stack) — verified locally (Worker + browser)
- [x] **Phase 4** — View vs edit links + rotate/disable — verified locally (Worker curl + browser)
- [x] **Phase 5** — (optional) password-gated links — verified locally (Worker curl + WS + browser)
- [x] **Phase 6** — Stop sharing / delete cloud map (owner)
- [x] **Phase 7** — Stable entity IDs (journey/stage/column/sub-journey/row/cell), backfilled on hydrate — prerequisite for 8 & 9
- [ ] **Phase 8** — Cell locking (soft, presence-driven advisory locks; acquire on edit-intent, heartbeat/TTL anti-hoard, release on blur/disconnect)
- [ ] **Phase 9** — Atomic op-based sync: `cell.set` content patches (per-cell LWW) + structural ops (row add/delete/move, column add/delete/move, stage/sub-journey/journey ops), version-gated with whole-doc resync fallback

## Log

### 2026-06-22 — Phase 7 done (stable entity IDs)

Gave every entity an immutable, opaque `id` (journey, stage + every nested
sub-stage / column leaf, sub-journey, row, cell). This is the **only** change in
Phase 7 — no protocol / WebSocket / Worker change, no `cellKey` /
`data-cell-key` change (those stay positional), no rendering / selection change.
IDs become part of the `journeys` blob already persisted to Dexie and pushed in
the Worker snapshot, so no schema/Worker migration is needed.

Client (`index.html`):

- New `newId()` helper (next to the structure helpers): `crypto.randomUUID()`
  with the same fallback shape as the presence clientId (`e_<rand><time>`).
- **Mint at birth in the base constructors:** `newCell()`, `newRow()`, and
  `blankCells()` now stamp an `id`. Because the divider/colspan transforms reuse
  these (and spread existing cells), most creation paths inherit ids for free.
- **Deep backfill in `hydrate()`** (the single funnel every load/import/remote-
  apply passes through): mints an `id` for ANY entity missing one and **never
  overwrites an existing id**, so old local (Dexie) and cloud docs upgrade
  transparently. A recursive `hydrateStage()` walks the stage tree to the leaves
  so nested sub-stages are covered.
- **Transform helpers carry ids forward (mint only for genuinely new cells):**
  `collapseDivider` keeps the first cell's id on the merged cell; `expandDivider`
  keeps it on the first re-expanded cell (the rest are padded by
  `normalizeRowCells` → `newCell()`); `normalizeRowCells` / `insertLeafIntoRow` /
  `removeLeafFromRow` spread existing cells (id preserved) and use `newCell()` for
  new leaves. `leafCellsToCells` now tracks emitted ids and re-mints if a **split
  span** would otherwise duplicate an id across two cells.
- **Structural creation sites updated:** `handleStageAction` `addStage` (the new
  stage literal) and `addSubStage` (the pushed `{title:"New"}` sub-stage) now get
  an `id`; the new column cell came from `newCell()` already. `newRow`-based
  inserts (`insertAbove`/`insertBelow`/`handleAddRow`) and new-journey creation
  (`createBlankJourney`, which wraps its template in `hydrate([...])`) are covered
  by the above.
- **Untouched (correctly):** `editCell`'s `JSON.stringify` equality dedup —
  since ids are stable across an edit, a no-op edit still early-returns;
  undo/redo stays whole-snapshot (ids are part of the snapshot). Both confirmed
  in verification. `editCell`/`editJourney` carry ids forward unchanged.
  `buildExampleProject` mutates post-hydrate but is only used to render the AI
  prompt JSON (line ~904), never loaded directly; on import it re-hydrates.

**Verification (static server :8755 + browser preview; live state read via the
React fiber `journeys` mirror; an `__auditIds` walker counted entities missing an
`id`). No console errors at any point:**

- **Deep ids on load:** opened a project → audit reported **0 missing ids** of
  31 cells / 11 rows / 3 stages / 1 sub-journey / 1 journey; sample cell id was a
  UUID.
- **Backfill of a genuinely id-less doc:** inspected Dexie directly — Project 2's
  persisted journeys had **no** stage/cell ids (only an old `journey-…` id).
  Opening it (runs `hydrate()`) produced a live state with UUIDs on every
  stage/cell and **0 missing ids**, while the original journey id was
  **preserved** (not overwritten) — proving deep backfill + id-preservation.
- **Mutations keep/ mint ids, no errors** (driven through the real App handlers):
  cell text edit → id unchanged, html updated; **no-op** edit (same html) →
  cell id + html stable (early-return holds); insert row → new row + all its
  cells have unique ids; delete row; add stage (new column leaf cells get ids);
  add sub-stage → nested sub-stage leaf gets a real id; toggle to divider →
  merged cell **carried the first cell's id forward**; toggle back → 4 cells, id
  preserved on the first, all unique; delete stage (drops a cell from every row)
  → 0 missing; add new tab/journey → journey + stages + sub-journey + rows +
  cells all id'd; **undo/redo** restored/re-applied the row delete with ids
  intact. Every step re-audited to **0 missing ids**.
- Screenshot of the working editor captured.

Limitations / follow-ups:
- IDs are not yet used by anything (still addressed positionally everywhere) —
  that is intentional; Phases 8 (locking) and 9 (op-based sync) consume them.
- The Load-JSON modal's two-step "Add sheets" confirm flow didn't apply a pasted
  id-less array in the automated run (an import-UI quirk, not a Phase 7 issue);
  the backfill was instead proven conclusively via the Dexie id-less → hydrate
  path above, which exercises the same `hydrate()` funnel.

A single optional password for the whole map (not per-link). The owner can set,
change, or remove it. When set, anyone opening a share link (editor or viewer)
must enter the password before the map loads; the **owner** (owner token) is
never prompted. Verification is server-side; the password never appears in any
URL — it travels only in a POST body. The gate is a **second knowledge factor on
top of the possession factor** (the link token); it does not replace token auth.

**Password storage scheme.** Salted **PBKDF2-SHA256**, 100,000 iterations, random
16-byte salt, 256-bit derived key, all hex-encoded. Only `pw:hash` (64 hex
chars) + `pw:salt` (32 hex chars) + `pw:enabled` ("1") are stored in `meta`; the
raw password is **never** persisted. Helpers `hashPassword(pw, saltHex?)` →
`{hashHex, saltHex}` and `verifyPassword(pw, saltHex, hashHex)` (constant-time
`safeEqual`) live in `worker/src/util.ts`.

**Session-token mechanism (keeps the password out of the WS URL).** When the
password is correct, `POST /api/maps/:id/access` mints a random 32-byte session
secret, stores only its **SHA-256 hash** in a new `sessions(token_hash, expires)`
SQLite table with a **12-hour** expiry, and returns the raw session to the
client once. The client keeps it in `sessionStorage` (per-tab) keyed by map id
and passes it as `&session=` to hydrate and the WS. Sessions are
opportunistically GC'd (expired rows deleted on mint/validate) and **wiped on
any password set/change/clear** (`DELETE FROM sessions`), so changing the
password re-locks open links on the next hydrate/reconnect.

**Gate enforcement (both data paths, owner bypass).** When `pw:enabled` and the
role is **not** owner:
- `handleGetDoc` (hydrate) requires a valid unexpired session, else **401**
  `{passwordRequired:true}` (so the client re-prompts rather than treating it as
  a dead link).
- `handleSync` (WS upgrade) requires the same session via `&session=`, else a
  **401** non-101 (no socket). The router (`worker/src/index.ts`) was fixed to
  forward `&session=` into the DO `/sync` URL (it previously only forwarded
  `token`).
Owners (owner token) bypass the password on `/access`, `/doc`, and `/sync`.

Worker (`worker/`):

- `src/util.ts`: added `hashPassword` / `verifyPassword` (PBKDF2-SHA256 + random
  salt, hex-encoded) plus `bytesToHex`/`hexToBytes`; constants
  `PBKDF2_ITERATIONS=100_000`, `PBKDF2_KEY_BITS=256`.
- `src/MapRoom.ts`:
  - New `sessions(token_hash, expires)` table; `SESSION_TTL_MS = 12h`.
  - `handleLinks` (owner-only) gained `setPassword` (body `{token,password}` →
    derive salt+hash, set `pw:hash`/`pw:salt`/`pw:enabled=1`, wipe sessions;
    empty password → 400) and `clearPassword` (delete `pw:*`, wipe sessions).
    Every links response now includes `passwordEnabled:boolean` (so `get`
    reflects status for the owner UI).
  - New owner-bypassing public `handleAccess(body)` (routed from `POST /access`):
    resolves role (403 invalid token), returns `{ok:true,role,passwordRequired:false}`
    for owner or pw-disabled, `{ok:false,passwordRequired:true}` + **401** for
    missing/wrong password, and `{ok:true,role,passwordRequired:false,session,expires}`
    + **200** for a correct password.
  - `handleGetDoc(token, session)` and `handleSync(token, session)` now enforce
    the session gate for non-owners when `pw:enabled`; helpers `passwordEnabled()`
    and `validSession(session)` added.
- `src/index.ts`: new route `POST /api/maps/:id/access` → `accessMap()` (CORS
  JSON, forwards to DO `/access`); `getMap` and the `/sync` upgrade now forward
  `&session=`.
- `cd worker && npx tsc --noEmit` passes.

Client (`index.html`, no grid/cell/stage logic touched):

- Session helpers `getMapSession`/`setMapSession` (sessionStorage, per-tab,
  keyed by map id) next to `getMapToken`.
- `apiGetMap(mapId, token, session)` now sends `&session=` and treats **401** as
  `err.passwordRequired`. New `apiAccessMap(mapId, token, password?)` (POSTs
  `/access`; 401 → `{ok:false,passwordRequired:true}`), `apiSetPassword`,
  `apiClearPassword` (via the existing `/links` owner path).
- New `passwordGate` state + `PasswordGateModal` (reuses the `m-ov`/`m-box`
  confirm-modal styling): on opening a `?map=` link the init effect probes
  `POST /access` first; if `passwordRequired` and no tab session is held, it
  strips `?token=` from the URL, shows the modal, and blocks the app until a
  valid session is obtained (`submitPassword` → store session → `mountCloudMap`)
  or the user cancels back to the library (`cancelPasswordGate`). A stale tab
  session that makes hydrate 401 also re-prompts. The hydrate/mount logic was
  extracted into a reusable `mountCloudMap(mapId, token, session)` callback.
- WS lifecycle effect appends `&session=` when a session is held.
- Owner Share menu gained a compact `PasswordControl` section (status Off/On, a
  Set/Change password input + Save, and Remove when on), reflecting
  `passwordEnabled` from the links response. Non-owners never see it (the whole
  Share control is already gated on `!viewOnly`).

**Verification (local: `wrangler dev --local` :8787 + managed static server
:8755 + browser preview; all servers/throwaway maps/scripts cleaned up):**

- Worker (curl + a Node `ws` client), all PASS:
  - Create map, set password as owner → links response `passwordEnabled:true`;
    `get` reflects it.
  - **Raw password is NOT stored**: direct SQLite dump shows `pw:hash` (64 hex),
    `pw:salt` (32 hex), `pw:enabled=1`, and `SELECT count(*) FROM meta WHERE v
    LIKE '%<rawpw>%'` = 0.
  - `/access` (viewer): wrong password → **401** `{ok:false}`; no password →
    **401** `{passwordRequired:true}`; correct → **200** `{ok:true, session}`.
  - **Hydrate** `GET /doc`: WITHOUT session → **401**; WITH session → **200**;
    OWNER without session → **200** (bypass).
  - **WS** `/sync`: viewer WITHOUT session → rejected **HTTP 401** (no socket);
    viewer WITH session → **OPEN (101)**; owner WITHOUT session → **OPEN (101)**.
    (This caught the router bug where `&session=` wasn't forwarded to the DO.)
  - Owner-only: viewer `setPassword` → **403**; bad token `/access` → **403**;
    empty `setPassword` → **400**.
  - `clearPassword` → `passwordEnabled:false`, viewer `/access` and `/doc`
    succeed with no session (regression = pre-Phase-5 behavior); `pw:*` rows
    removed and `sessions` table emptied.
- Browser (real app via preview), no console errors:
  - Opened a gated **viewer** link → the **Password required** modal appears and
    `?token=` is stripped from the URL (only `?map=` remains). Wrong password →
    inline "Incorrect password. Please try again." (stays on prompt). Correct
    password → map loads **read-only** ("Gated Journey"), a 43-char session is in
    `sessionStorage`, Share control hidden (viewer). Screenshots captured.
  - Opened the same map as **owner** → no prompt; Share menu shows the new
    **Password: On** section with Change password + Remove. Clicked **Remove** →
    UI flips to **Off** and the server reports `passwordRequired:false`.
  - Reopened the (now unprotected) viewer link in a cleared tab → loads directly,
    **no prompt** (regression check).

Limitations / follow-ups:
- One password for the whole map (not per-link), by design (MVP scope).
- Sessions are per-tab (`sessionStorage`); a new tab re-prompts (acceptable — a
  `localStorage` session would persist across tabs but linger longer).
- Changing/removing the password wipes sessions but does **not** force-disconnect
  currently-connected sockets (same Phase-4 trade-off); the new rule applies on
  the next hydrate/reconnect.
- No rate-limiting on `/access` password attempts (PBKDF2 cost provides some
  brute-force resistance; an explicit attempt limiter is a future hardening).

### 2026-06-22 — Fix: Menu dropdown clipped off-screen on narrow viewports

The shared `Menu` component (used by the Export menu, the Share ▾ menu in
`ShareControl`, and the row/cell option menus) positioned its body-level portal
purely from the trigger rect: `align="right"` pinned the popup's right edge to
the trigger via a CSS `right` value, with no viewport clamping. On narrow
screens (~800px and below) this pushed the popup's left edge past x=0 — clipping
it off the edge. The Share popup (`minWidth: 280`) was the worst case.

Fix is entirely in `Menu` (so every menu benefits; no special-casing): the
positioner now always resolves to a single `left` coordinate (`r.right - width`
for `align="right"`, else `r.left`) and clamps it into
`[8, innerWidth - width - 8]` so the popup stays fully on-screen with an 8px
margin. The popup width is measured from the rendered node via `popRef`
(falling back to the 184px CSS min-width on the first frame), and a
`requestAnimationFrame` re-place runs after mount so the clamp uses the real
measured width. Existing `max-width: calc(100vw - 16px)` is retained as a
backstop. Wide-screen alignment is unchanged (when there's room, the right edge
still lands under the trigger).

**Verified** via the Export menu (shares the same `Menu` code path; the Share
menu needs the Worker to render its rows). Opened Project 1 in the static
preview and measured the portal rect: at 375px width the menu settled at
left=178 / right=375 (= innerWidth−8, not clipped); at 800px it stayed
right-aligned to the trigger (popRight 500 = triggerRight 500, not clipped).
Screenshots captured at both widths; no console errors.

Owner-only management of the editor/viewer share links: retrieve (after a
reload), enable/disable, and rotate. This closes the Phase 1 gap where the
editor/viewer tokens were only available in memory right after enabling and were
lost on reload ("Reopen to get links").

**Security trade-off (explicit & documented).** Tokens are still hash-only in
the `capabilities` table, but the DO now ALSO stores the raw **editor** and
**viewer** secrets in `meta` (`token:editor` / `token:viewer`). This is the only
way to let the owner re-read and copy the share links after a reload (you cannot
recover a raw token from its hash), and it lets "rotate" replace the stored raw
token. The **owner** key is deliberately never stored raw — only its hash. The
editor/viewer tokens are share secrets the owner is entitled to see, so storing
them raw, gated behind owner-only auth, is an acceptable MVP trade-off. Recorded
in code comments (`InitBody` in `MapRoom.ts`, the `createMap` init call in
`index.ts`) and here.

Worker (`worker/`):

- `src/MapRoom.ts`:
  - `InitBody` extended with `shareTokens:{editor,viewer}`; `handleInit` now
    `setMeta("token:editor"/"token:viewer", …)` alongside the existing hash rows.
  - New `handleLinks(body)` (routed from `POST /links` in `fetch`): owner-only
    (verifies `roleForToken(token) === "owner"`, else 403). Actions: `get`
    (returns both links), `rotate` (mint new `randomSecret()`, update `meta` raw
    token + `capabilities.token_hash`, force `enabled=1`), `setEnabled`
    (flip `capabilities.enabled`). Every action returns the current
    `{ links:{ editor:{token,enabled}, viewer:{token,enabled} } }` via the new
    `readLinks()` helper. Imports `randomSecret` from `./util`.
  - Existing `roleForToken` already filters `WHERE enabled = 1`, so a disabled
    token is rejected with no change needed (verified).
- `src/index.ts`:
  - `createMap` now passes `shareTokens:{editor,viewer}` into the DO `init`.
  - New route `POST /api/maps/:id/links` → `manageLinks()` forwards the JSON body
    to the DO `POST /links` and returns its JSON with CORS (normal JSON endpoint,
    not a WebSocket). The DO enforces owner-only auth.
- `cd worker && npx tsc --noEmit` passes.

Client (`index.html`, no grid/cell/stage logic touched):

- New fetch wrappers after `apiGetMap`: `apiManageLink(mapId, ownerToken,
  {action,role,enabled})` (POSTs `/api/maps/:id/links`, maps 403→"Only the map
  owner…") and `apiGetLinks(mapId, ownerToken)`.
- `Menu` gained an `onOpen` callback (fired when the menu opens) so the Share
  menu can lazily fetch links on open.
- `mapLinkFor(mapId, token)` extracted (builds `?map=<id>&token=<token>`).
- New `ShareLinkRow` component: per-link (edit/view) Copy (disabled when the link
  is disabled), Enable/Disable toggle, and a two-step Rotate (Rotate → "Confirm
  rotate", since it invalidates the old link). Each action calls
  `apiManageLink` and feeds the returned `links` back up via `onChange`.
- `ShareControl` reworked: when synced **and** `sync.role === "owner"`, it
  fetches the current links on menu-open (`getMapToken(mapId)` for the owner
  token) and renders two `ShareLinkRow`s — works **after a reload** (reads from
  the server, not memory). The old in-memory `tokens` captured at enable time is
  removed. Non-owners never see management UI: `ShareControl` is rendered only
  `{!viewOnly && …}`, so for viewers (viewOnly) the Share menu is hidden
  entirely (server also enforces owner-only). The not-synced "Enable sync"
  button is unchanged; `enableSync` still works (its return value is no longer
  needed for links).

**Verification (local: `wrangler dev --local` :8787 + static server :8755 +
browser preview; all servers/throwaway tokens cleaned up after):**

- Worker (curl), all PASS:
  - Create map → `{mapId, tokens:{owner,editor,viewer}}`.
  - (simulated reload) `POST /links {action:"get"}` with owner token → returns
    editor+viewer tokens, both `enabled:true`.
  - `setEnabled viewer false` → `GET /api/maps/:id?token=<viewer>` = **403**;
    re-enable → **200**.
  - `rotate editor` → old editor token **403**, new editor token **200**.
  - Non-owner (editor) token on `/links` → **403**; bad token → **403**.
- Browser (real app via preview), no console errors:
  - Opened a project → "Enable sync" → URL `?map=…`, owner token in
    localStorage. **Reloaded** the `?map=` URL → opened straight into the synced
    project. Opened the Share menu → it fetched and listed both **Edit link** and
    **View-only link** as "Active" with Copy / Disable / Rotate — proving links
    are retrievable after a reload.
  - Clicked Disable on the view link → row shows "Disabled" + "Link disabled"
    (copy disabled) + an Enable button. Re-enabled it → "Active" again.
  - Clicked Rotate → "Confirm rotate" → confirmed; a server `get` confirmed the
    editor token changed and the link stayed active.
  - Opened a **viewer** link (`?map=…&token=<viewer>`): app rendered view-only,
    Share menu and Library button hidden (no management UI for non-owners); token
    consumed + stripped from the URL.

Limitations / follow-ups:
- Rotating or disabling a link does **not** force-disconnect currently-connected
  editor/viewer WebSockets; an existing live socket keeps its session until it
  reconnects, at which point the new auth applies. Acceptable for the MVP (no
  forced-disconnect machinery added on purpose).
- The Share popup can be clipped on very narrow viewports (right-aligned body
  portal near the left edge); content is correct, only off-screen on ~800px —
  cosmetic, not a Phase 4 regression.
- No password-gated links yet (Phase 5).

### 2026-06-21 — Phase 3 done (Presence)

Ephemeral presence: who else is currently in a shared map, shown as an avatar
stack in the app bar. Presence is **never persisted** — it lives only in each
socket's attachment (in-memory across hibernation) and is broadcast as a roster;
no SQLite, no cursors (cursors remain explicitly out of scope for later).

Wire format added (minimal):

- `client -> server  { t:"presence.update", clientId, name, color }` — sent on
  socket open and (future) when the name changes.
- `server -> client  { t:"presence", peers:[{clientId,name,color}, ...] }` —
  the full roster; clients filter out their own `clientId`.

Worker (`worker/src/MapRoom.ts`):

- `SocketAttachment` extended to `{ role; clientId?; name?; color? }` — presence
  identity rides alongside the existing role, still only in `serializeAttachment`.
- `webSocketMessage` now branches on `presence.update` **before** the `doc.push`
  gate: it requires a role (any role — viewers included, presence is **not**
  role-gated), merges `clientId`/`name`/`color` into the attachment (preserving
  `role`, with length caps), then calls `broadcastPresence()`. `doc.push` is still
  owner/editor-only. Malformed/unknown frames and roleless sockets are ignored.
- New `broadcastPresence(except?)` helper: iterates `this.state.getWebSockets()`,
  reads each `deserializeAttachment()` (cast + null-guarded), includes only
  sockets that have announced a `clientId`, and sends `{t:"presence",peers}` to
  every socket (optionally excluding one). Because the announcing socket is
  included, a late joiner gets the current roster immediately after its first
  `presence.update`.
- `webSocketClose` / `webSocketError` now call `broadcastPresence(ws)` (excluding
  the departing socket explicitly, so peers see the departure even if the closing
  socket still lingers in `getWebSockets()`).
- `cd worker && npx tsc --noEmit` passes.

Client (`index.html`, no grid/cell/stage logic touched):

- Presence identity helpers near the sync config: `getPresenceIdentity()` returns
  a stable per-browser `{clientId, name, color}` — `clientId` via
  `crypto.randomUUID()`, a friendly `"Anonymous <animal>"` name, and a
  deterministic HSL `color` (hue hashed from the clientId via `hashHue`). Both
  clientId and name are persisted in `localStorage` (`sjm:presenceId` /
  `sjm:presenceName`) so a refresh keeps the same identity; `presenceInitials()`
  derives the badge text.
- New `peers` `useState` in `App` (roster excluding self).
- WS lifecycle effect: `ws.onopen` now also sends a `presence.update`; the
  `onmessage` handler routes `{t:"presence"}` to `setPeers(peers filtered by
  myId)`. `peers` is cleared on socket close and on effect cleanup (leaving the
  map).
- New `PresenceStack` component (overlapping circular badges, color + initials,
  `title` = full name, capped at 5 + a "+N" badge) rendered inside `.ab-actions`
  in `TopBar`, gated on `sync.status === "synced" && peers.length > 0` — **not**
  on `!viewOnly`, so it shows for viewers too. CSS: `.presence-stack` /
  `.presence-av` reusing `--surface` / `--surface-2` / `--text-sec` tokens.

Verification (local: `wrangler dev --local` :8787 + static server :8755 +
throwaway Node `WebSocket` clients, all now deleted):

- Server-side (`/tmp/presence-test.mjs`, all assertions PASS): A announces →
  A's own roster has 1 entry (A). B announces → both A and B receive a 2-entry
  roster each containing the OTHER peer (and B sees A's name). A **viewer**-token
  socket announces and appears in the roster (presence not gated by role). B
  disconnects → A and the viewer receive an updated roster **without** B.
- Browser (real app via preview): enabled sync (URL → `?map=`, owner token +
  `sjm:presenceId`/`sjm:presenceName` in localStorage), then a Node owner-peer
  connected to the same map → the avatar stack appears with a blue "AH"
  badge, `title="Anonymous Heron"`, aria-label "1 other person here"
  (screenshot captured); when the peer left, the stack disappeared. Opened a
  **viewer link** (`?map=…&token=<viewer>`): Library/Share controls hidden
  (view-only), but with a peer connected the presence stack still renders the
  "AH" badge — confirming presence shows in view-only mode. No console errors
  throughout (a temporary debug `console.log` confirmed `frame peers=2 …
  filtered=1` and was removed).

Limitations / follow-ups:
- Anonymous identity only; no editable display name UI yet (name is persisted but
  not user-settable in the UI). `presence.update` is sent only on open, so a name
  change would currently require a reconnect.
- No live cursors (deliberately deferred per the design).
- Roster is rebuilt from `getWebSockets()` on every change; fine at MVP scale.
- Reconnects can briefly leave stale sockets in `getWebSockets()` until the DO
  evicts them; the `except`-on-close broadcast plus client-side self-filtering
  keep the visible roster correct.

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
