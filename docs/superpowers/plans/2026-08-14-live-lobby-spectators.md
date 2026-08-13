# Live Lobby and Spectators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real multi-room public lobby with direct card-based joining, private invite rooms, and read-only spectators with live presence profiles on the game screen.

**Architecture:** Add a singleton `LobbyRegistry` Durable Object containing bounded public room projections while preserving each `ChessRoom` Durable Object as the sole authority for seats, game state, clocks, sessions, and spectator presence. Extend the existing capability-authenticated HTTP/WebSocket client, move lobby rendering into a focused frontend module, and add spectator controls to the existing game shell. Poll discovery at a bounded visibility-aware interval; every Join and Watch action is revalidated by the room.

**Tech Stack:** JavaScript ES modules, Cloudflare Workers, SQLite Durable Objects, WebSockets with hibernation, chess.js, Vite 7, Node test runner, Vitest Cloudflare Workers pool, happy-dom, CSS, generated compressed WebP/PNG assets.

## Global Constraints

- Public rooms are discoverable; private rooms and their metadata are never enumerable.
- `ChessRoom` remains authoritative. A lobby projection never grants Join or Watch authority.
- New rooms default to `visibility: "public"` and `allowSpectators: true`.
- Player and spectator capabilities are random, room-scoped, digest-only at rest, and never placed in query strings or public summaries.
- Private player and private watch invites are separate capabilities.
- Spectators may send only `sync` and `ping`; move and resign return `unauthorized_role` without changing revision or FEN.
- Lobby pages contain at most 24 validated room summaries; rooms expire after the existing 24-hour TTL.
- At most 50 connected spectators are listed per room; disconnected sessions are neither counted nor displayed.
- Names are guest display names, avatars come from a fixed enum, and the UI must not imply accounts, ratings, verification, countries, or persistent profiles.
- Keep `.battle-room-id.txt`, `.serena/`, and `docs/firebase_roadmap.md` unstaged and unchanged.
- No new runtime package unless current platform APIs and installed dependencies cannot provide the behavior.

---

### Task 1: Public room and spectator protocol contracts

**Files:**
- Modify: `worker/protocol.js`
- Modify: `worker/game-state.js`
- Modify: `test/protocol.test.js`
- Modify: `test/game-state.test.js`

**Interfaces:**
- Produces: `AVATARS`, `VISIBILITIES`, `parseLobbyQuery(url)`, `parsePublicJoinRequest(value)`, and `parseWatchRequest(value)`.
- Extends: `parseCreateRequest(value)` to return `visibility`, `allowSpectators`, and `avatar`.
- Extends: `createGameState(input, now)` with public profile and room visibility fields.
- Extends: `joinGameState(state, playerName, now, avatar)` without weakening existing one-time invite behavior.

- [ ] **Step 1: Write failing protocol tests**

Add cases asserting that create defaults to public/watchable, accepts only fixed avatar IDs, public join accepts exactly `playerName` and `avatar`, watch accepts those fields plus an optional 43-character watch capability, and lobby query accepts only `all|open|watch`, known time categories, a bounded search string, and an opaque cursor.

- [ ] **Step 2: Run focused protocol tests and verify RED**

Run: `node --test test/protocol.test.js`

Expected: failures because the new exports and fields do not exist.

- [ ] **Step 3: Implement strict parsers and constants**

Use these exact public enums:

```js
export const AVATARS = Object.freeze(['knight', 'king', 'rook', 'bishop', 'pawns', 'shield']);
export const VISIBILITIES = Object.freeze(['public', 'private']);
```

Reject unknown keys and preserve the current 40-character display-name and 80-character title limits. `parseLobbyQuery` returns `{ status, time, search, cursor }`, with a 60-character search limit and a cursor matching base64url characters up to 120 characters.

- [ ] **Step 4: Write failing game-state profile tests**

Assert that new state contains `visibility`, `allowSpectators`, `hostAvatar`, and `guestAvatar`; public state exposes profile avatars but no capability material; and joining records the guest avatar.

- [ ] **Step 5: Implement the minimal game-state extension**

Keep chess state/revision behavior unchanged. Extend `toPublicState` with `visibility`, `allowSpectators`, and player avatar fields only.

- [ ] **Step 6: Run domain tests and verify GREEN**

Run: `npm run test:domain`

Expected: all existing and new domain tests pass.

---

### Task 2: Bounded LobbyRegistry Durable Object

**Files:**
- Create: `worker/lobby-registry.js`
- Create: `test/lobby-registry.test.js`
- Modify: `worker/index.js`
- Modify: `wrangler.jsonc`
- Modify: `vitest.config.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `export class LobbyRegistry extends DurableObject`.
- Internal routes: `POST /upsert`, `POST /remove`, and `GET /list`.
- Public route: `GET /api/lobby?status=all|open|watch&time=all|bullet|blitz|rapid|unlimited&search=...&cursor=...`.
- Projection shape: `{ roomId, title, status, host, guest, openColor, timeControlId, createdAt, updatedAt, spectatorCount, allowSpectators, expiresAt }`.

- [ ] **Step 1: Write failing registry runtime tests**

Use the Workers Vitest pool to upsert at least three public projections, list no more than 24, filter Open and Watchable states, search title/host, reject malformed cursors, page with a cursor, remove an entry, and lazily omit expired entries. Assert returned objects contain no token, digest, FEN, or moves.

- [ ] **Step 2: Run the registry tests and verify RED**

Run: `npx vitest run test/lobby-registry.test.js`

Expected: import or binding failure because `LobbyRegistry` does not exist.

- [ ] **Step 3: Implement SQLite-backed registry storage**

Create a `rooms` table keyed by `room_id` with explicit columns for the projection. Use parameterized SQL, deterministic `updated_at DESC, room_id ASC` ordering, encoded `(updatedAt, roomId)` cursors, page size 24, and lazy expiry deletion. Do not accept `visibility` from a projection: only public rooms may call `upsert`.

- [ ] **Step 4: Add the Worker binding and public list route**

Add `LobbyRegistry` to Worker exports and `LOBBY` to `durable_objects.bindings` and declarative SQLite exports. Route public requests through `parseLobbyQuery`; route internal registry calls only through the Durable Object stub.

- [ ] **Step 5: Add the test file to package scripts and verify GREEN**

Run: `npm run test:worker`

Expected: registry and existing Worker tests pass.

---

### Task 3: Public creation, direct Join, and registry projection updates

**Files:**
- Modify: `worker/index.js`
- Modify: `worker/room.js`
- Modify: `worker/game-state.js`
- Modify: `test/worker.integration.test.js`

**Interfaces:**
- Adds Room route: `POST /join-public`.
- Adds Worker route: `POST /api/rooms/:id/join-public`.
- Adds `ChessRoom.publicProjection(state)` and `ChessRoom.queueRegistrySync(state)`.
- Create response retains `inviteToken` and adds `watchInviteToken` only for sharing from the room screen.

- [ ] **Step 1: Write failing integration tests for multiple rooms**

Create three public rooms and one private room. Assert the public list contains exactly the public rooms, with distinct host/title/time data, and never contains the private room ID or title.

- [ ] **Step 2: Write a failing direct-Join race test**

Issue two concurrent `join-public` requests to the same waiting room. Assert exactly one returns 200 and the other returns `room_full`; the final canonical state has one guest and revision advances once.

- [ ] **Step 3: Run Worker integration and verify RED**

Run: `npm run test:worker`

Expected: missing list/public-join behavior.

- [ ] **Step 4: Implement public/private creation and projection registration**

Create the room first. For public rooms, call the registry only after successful room storage. Private creation returns separate player and watch invite capabilities but performs no registry upsert.

- [ ] **Step 5: Implement atomic public Join inside ChessRoom**

Validate `state.visibility === 'public'`, call the existing authoritative seat-claim domain function, create the guest session, consume the player invite so the seat cannot be claimed twice, persist before broadcasting, and enqueue a registry sync. Return `room_not_public`, `room_full`, or `room_expired` truthfully.

- [ ] **Step 6: Synchronize projections on state changes and expiry**

Upsert after seat claim, move/result transition, spectator-count change, and relevant connect/disconnect events. Remove on expiry. Use an idempotent microtask-level `queueRegistrySync` so same-turn changes coalesce. Registry failure must be caught and logged without changing canonical state or returning false game success.

- [ ] **Step 7: Run Worker integration and verify GREEN**

Run: `npm run test:worker`

Expected: multi-room listing, private omission, race safety, and legacy invite tests pass.

---

### Task 4: Spectator capability, role enforcement, presence, and reconnect

**Files:**
- Modify: `worker/room.js`
- Modify: `worker/game-state.js`
- Modify: `test/worker.integration.test.js`

**Interfaces:**
- Adds Room route: `POST /watch`.
- Adds Worker route: `POST /api/rooms/:id/watch`.
- Spectator session response: `{ roomId, sessionToken, role: 'spectator', color: null, state }`.
- Public state adds `spectators: Array<{ id, name, avatar }>` and `spectatorCount`.

- [ ] **Step 1: Write failing spectator integration tests**

Start a public game, create two spectator sessions, connect both, and assert both players receive the same count and profile list. Attempt spectator `move` and `resign`; assert `unauthorized_role`, unchanged revision, and unchanged FEN. Reload one spectator socket with the same session and assert the prior socket is replaced and the profile is counted once.

- [ ] **Step 2: Add failure tests**

Assert private Watch requires the dedicated watch invite, player invite cannot Watch, spectator invite cannot Join, disabled spectators return `spectators_disabled`, and the 51st active spectator returns `spectator_limit`.

- [ ] **Step 3: Run focused Worker tests and verify RED**

Run: `npx vitest run test/worker.integration.test.js`

Expected: missing Watch route/session behavior.

- [ ] **Step 4: Implement spectator session issuance**

Store spectator digests and fixed-enum public profiles under a separate storage key. Keep at most 100 reconnectable records by pruning the oldest disconnected records; reject creation when 50 spectator sockets are active. A private Watch request must validate `watchInviteDigest` without consuming it.

- [ ] **Step 5: Extend WebSocket role resolution and presence**

Accept sockets with tags `spectator` and `spectator:<public-id>`. Replace only an existing socket for the same spectator ID. Derive the public spectator list from active socket attachments, sort by connection time then ID, and never count stored but disconnected sessions.

- [ ] **Step 6: Enforce read-only commands**

Allow spectator `ping` and `sync` before game-command dispatch. For all other parsed commands send `{ type: 'error', code: 'unauthorized_role' }` and do not write storage.

- [ ] **Step 7: Verify spectator tests GREEN**

Run: `npm run test:worker`

Expected: all room, lobby, and spectator integration tests pass.

---

### Task 5: Frontend lobby and spectator transport contracts

**Files:**
- Modify: `src/online.js`
- Create: `src/lobby.js`
- Modify: `test/online.test.js`
- Create: `test/lobby.test.js`
- Modify: `package.json`

**Interfaces:**
- `OnlineRoomClient.listLobby(filters, signal)` returns `{ rooms, nextCursor, serverTime }`.
- `OnlineRoomClient.joinPublic(roomId, profile)` and `OnlineRoomClient.watch(roomId, profile, watchInviteToken?)` establish and persist role-scoped sessions.
- `validateLobbyResponse(value)` returns validated public summaries only or a structured failure.
- `filterLobbyRooms(rooms, { tab, time, search })` performs client display filtering without inventing rooms.
- `createLobbyView(options)` owns rendering and visibility-aware refresh lifecycle.

- [ ] **Step 1: Write failing transport and validation tests**

Assert URL encoding, AbortSignal use, public Join body shape, Watch body shape, spectator session persistence, strict summary validation, no capability fields in summaries, and role-aware session restoration.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/online.test.js test/lobby.test.js`

Expected: missing APIs and validators.

- [ ] **Step 3: Implement transport methods and validators**

Reuse the existing bound `fetch` behavior and WebSocket subprotocol. Extend `validSession` to accept `spectator` with `color: null` while preserving player validation.

- [ ] **Step 4: Implement bounded polling lifecycle**

`createLobbyView` fetches immediately, polls every 8 seconds while `document.visibilityState === 'visible'`, stops while hidden, resumes with an immediate fetch, aborts prior requests on refresh, and exposes `destroy()` to remove timers/listeners.

- [ ] **Step 5: Verify frontend contract tests GREEN**

Run: `npm run test:domain`

Expected: transport, validation, filtering, and lifecycle tests pass.

---

### Task 6: Replace invite-entry Join UI with authoritative multi-room lobby

**Files:**
- Modify: `src/main.js`
- Modify: `src/lobby.js`
- Modify: `src/styles.css`
- Create: `test/lobby-ui.test.js`
- Modify: `test/online-ui.test.js`
- Modify: `package.json`

**Interfaces:**
- `createLobbyView({ root, client, profile, recentRooms, onCreate, onJoin, onWatch, onReconnect, onClose })`.
- Existing direct invite parsing remains an automatic private/direct-link landing flow and is not rendered as the default Join form.

- [ ] **Step 1: Write failing DOM tests for lobby states**

Use happy-dom to assert loading skeletons, authoritative cards, Open/Watch action labels, filters, search, empty state, stale error state with disabled actions, recent-room separation, keyboard-accessible controls, and no invite textbox in the normal Join screen.

- [ ] **Step 2: Run UI tests and verify RED**

Run: `node --test test/lobby-ui.test.js test/online-ui.test.js`

Expected: current invite-entry panel violates the new assertions.

- [ ] **Step 3: Implement the Night Tournament Hall lobby shell**

Build semantic header, profile control, live room count, tabs, time filter, search, refresh button, card grid, and Recent/Reconnect section. Render all user/server text with `textContent`; do not interpolate it into HTML.

- [ ] **Step 4: Wire card actions to authoritative client calls**

Join enters the board only after the room returns a player session. `room_full` refreshes the card and offers Watch only through a separate user click. Watch enters spectator mode. Reconnect requires a valid stored session and a successful socket sync.

- [ ] **Step 5: Preserve direct private invitation flow**

When `?room=...#invite=...` is present, show the compact invitation landing card and consume the capability only through the correct player/watch action. Clear the fragment after successful claim.

- [ ] **Step 6: Add responsive and accessible styling**

Use three/two/one-column breakpoints, visible focus rings, non-color status labels, reduced-motion handling, sticky mobile filters, and disabled stale cards. Keep the existing park background and avoid horizontal overflow at 360px.

- [ ] **Step 7: Verify lobby UI tests GREEN**

Run: `npm run test:domain`

Expected: all lobby and existing UI tests pass.

---

### Task 7: Spectator board mode and eye/profile panel

**Files:**
- Modify: `src/ui.js`
- Modify: `src/controller.js`
- Modify: `src/main.js`
- Modify: `src/styles.css`
- Modify: `test/online-controller.test.js`
- Create: `test/spectator-ui.test.js`
- Modify: `package.json`

**Interfaces:**
- `Controller.start(MODES.ONLINE, { action: 'watch', roomId, playerName, avatar, watchInviteToken? })`.
- `UI.setSpectators({ visible, spectators })` updates count and profiles.
- `UI.setOnlineRole(role)` hides player-only actions and applies spectator layout.

- [ ] **Step 1: Write failing controller tests**

Assert spectator canonical snapshots render but Chessground has no movable color/destinations, local moves are never sent, resign is hidden/blocked, and player behavior remains unchanged.

- [ ] **Step 2: Write failing spectator UI tests**

Assert the eye button has an accessible count label, opens a profile panel, lists only validated profiles, supports Escape and focus return, reports zero viewers truthfully, and uses dialog/bottom-sheet semantics at narrow width.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `node --test test/online-controller.test.js test/spectator-ui.test.js`

Expected: missing spectator role and UI refs.

- [ ] **Step 4: Implement controller spectator mode**

Route Watch through `OnlineRoomClient.watch`, set `onlineRole`, keep board orientation conventional unless a future preference exists, sync canonical state, and configure Chessground with `movable.color = undefined` and no destinations.

- [ ] **Step 5: Implement eye control and profile panel**

Add an inline SVG eye icon, numeric badge, accessible button, popover panel, avatar emblem, display name, and `Watching` label. Hide player-only resign/undo actions for spectators. Use focus trapping appropriate to the existing modal helper and return focus on close.

- [ ] **Step 6: Verify spectator UI GREEN**

Run: `npm run test:domain`

Expected: all controller and spectator UI tests pass.

---

### Task 8: Generate and integrate lightweight lobby assets

**Files:**
- Create: `public/assets/lobby/lobby-emblems.png`
- Create: `public/assets/lobby/night-tournament-hall.webp`
- Create: `public/assets/lobby/empty-lobby.webp`
- Modify: `src/lobby.js`
- Modify: `src/styles.css`
- Modify: `test/lobby-ui.test.js`

**Interfaces:**
- Fixed avatar IDs map to six positions in a 3x2 transparent emblem atlas.
- All generated images are decorative and have CSS/glyph fallbacks.

- [ ] **Step 1: Generate the approved visual assets**

Generate a cohesive premium nocturnal chess set: a transparent 3x2 atlas containing Knight, Crowned King, Rook Tower, Moon Bishop, Twin Pawns, and Royal Shield; one wide low-contrast tournament-hall banner; and one empty chess-table illustration. No text, faces, flags, logos, or ratings.

- [ ] **Step 2: Inspect and compress assets**

Visually inspect each image, ensure no baked text or malformed chess symbols, resize to practical display resolution, and keep the combined transfer size bounded. Preserve transparency for the atlas and use WebP for opaque illustrations.

- [ ] **Step 3: Integrate with resilient fallbacks**

Map fixed avatar IDs to atlas positions. Add an `error` fallback to semantic chess glyphs. Mark decorative banner/empty art with empty alt text and ensure room title/status remains understandable without images.

- [ ] **Step 4: Add asset contract tests**

Assert every avatar enum has a mapping, fallback text exists, and normal Join/Watch actions do not depend on image load completion.

- [ ] **Step 5: Verify UI and production build**

Run: `npm run test:domain && npm run build`

Expected: tests and build pass; asset URLs resolve into `dist/assets/lobby/`.

---

### Task 9: End-to-end verification, docs, commit, and deployment handoff

**Files:**
- Modify: `README.md`
- Modify: `.dev.vars.example` only if a new public non-secret variable is required
- Modify: tests from prior tasks only for defects found during verification

**Interfaces:**
- Documents player Join, private invites, spectator Watch, local development, tests, and Cloudflare deployment.

- [ ] **Step 1: Run the full automated gate**

Run:

```powershell
npm test
npm run build
npx wrangler deploy --dry-run
npm audit --audit-level=high
git diff --check
```

Expected: every command exits 0. Record the upstream chess.js sourcemap warning separately if it remains non-actionable.

- [ ] **Step 2: Scan release output and staged source**

Search for GitHub API/token keys, Cloudflare deploy credentials, raw test capabilities, private room names/IDs from browser proof, and invite/watch/session capabilities. Harmless user-facing copy stating that GitHub Token is unnecessary may remain.

- [ ] **Step 3: Run browser proof with independent contexts**

Start Wrangler and Vite. Create three public rooms and one private room in isolated contexts. Verify only public rooms list, direct card Join works without an invite field, a second racing Join fails safely, two spectators appear under the eye panel on both player screens, a spectator protocol mutation is rejected, player and spectator reload/reconnect, and desktop plus 360px mobile views have no overflow or console error.

- [ ] **Step 4: Verify public deployment when authentication permits**

Deploy the Worker/assets and repeat Create → Lobby → Join → Watch over HTTPS. If only a temporary Cloudflare account is available, label that proof temporary and preserve the Stockfish asset-size limitation separately from Online Lobby correctness.

- [ ] **Step 5: Update README with exact usage**

Document Public/Private creation, Join from lobby cards, Share links, spectator Watch, eye/profile panel, local commands, and deployment boundaries. Do not claim accounts, ratings, moderation, or production durability not proven by the deployment.

- [ ] **Step 6: Commit and push the verified implementation**

Stage only the feature files listed in this plan. Leave user-owned untracked files untouched. Use descriptive feature/docs commits, push without force, and verify local HEAD equals `refs/heads/main` on origin.
