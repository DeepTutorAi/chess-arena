# Authoritative Online Rooms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the player-facing GitHub-token room workflow with invite-only, server-authoritative human chess rooms on Cloudflare Workers Free and Durable Objects.

**Architecture:** The Vite client sends move intent over an authenticated WebSocket. One SQLite-backed Durable Object owns each room, validates commands with `chess.js`, persists canonical snapshots, and broadcasts through hibernatable sockets. The legacy Gist agent protocol remains isolated and operational for terminal AI clients.

**Tech Stack:** Vite 7, JavaScript ES modules, chess.js 1.4, Cloudflare Workers, SQLite-backed Durable Objects, WebSocket Hibernation API, Vitest Workers pool, Playwright browser verification.

## Global Constraints

- No GitHub, Cloudflare, or other deploy credential may be exposed to the browser bundle.
- The server is authoritative for FEN, turn, legal moves, result, revision, player role, and clocks.
- The invite capability is one-time and the two session capabilities are room-scoped.
- Preserve the legacy Gist agent-battle scripts and protocol; do not route player UI through them.
- Public lobby, accounts, ratings, spectators, and chat are outside this implementation slice.
- Local, emulator, and deployed proof must be reported as separate levels.

---

### Task 1: Pure Authoritative Game Domain

**Files:**
- Create: `worker/game-state.js`
- Test: `test/game-state.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `createGameState(input, now)`, `applyGameCommand(state, actor, command, now)`, `realizeTimeout(state, now)`, and `toPublicState(state, connections)`.
- `actor` is `{ role: 'host'|'guest', color: 'w'|'b' }`; commands never contain canonical state.

- [ ] Write table-driven Node tests with hand-derived snapshots for room creation, legal `e2e4`, illegal `e2e5`, wrong color, stale revision, resignation, checkmate, elapsed clock plus increment, and timeout.
- [ ] Run `node --test test/game-state.test.js`; verify RED because `worker/game-state.js` does not exist.
- [ ] Implement the smallest pure domain functions using `Chess` from `chess.js`; validate all external fields before mutation and return typed `{ ok, state, error }` results.
- [ ] Run `node --test test/game-state.test.js`; verify GREEN with no warnings.

### Task 2: Capability and Protocol Boundaries

**Files:**
- Create: `worker/capabilities.js`
- Create: `worker/protocol.js`
- Test: `test/capabilities.test.js`
- Test: `test/protocol.test.js`

**Interfaces:**
- Produces: `createCapability()`, `digestCapability(value)`, `safeDigestEqual(a, b)`, `parseCreateRequest(value)`, `parseJoinRequest(value)`, and `parseSocketCommand(value)`.
- All parsers return `{ ok: true, value }` or `{ ok: false, code, message }`; no parser throws on user input.

- [ ] Write failing tests for randomness shape, digest comparison, malformed JSON values, unknown fields that claim canonical authority, invalid squares/promotions, oversized names/titles, and valid create/join/move commands.
- [ ] Run `node --test test/capabilities.test.js test/protocol.test.js`; verify RED from missing modules.
- [ ] Implement Web Crypto capability helpers and bounded schema parsers with explicit allowlists.
- [ ] Run both test files; verify GREEN.

### Task 3: Durable Object and Worker HTTP Router

**Files:**
- Create: `worker/index.js`
- Create: `worker/room.js`
- Create: `wrangler.jsonc`
- Create: `vitest.config.js`
- Create: `test/worker.integration.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces HTTP `POST /api/rooms`, `POST /api/rooms/:id/join`, and WebSocket `GET /api/rooms/:id/socket`.
- Durable Object binding is `ROOMS`; exported class is `ChessRoom` with SQLite storage declared in `wrangler.jsonc`.

- [ ] Install the current compatible `wrangler`, `vitest`, and `@cloudflare/vitest-pool-workers` dev dependencies and record exact versions in the lockfile.
- [ ] Write Worker-runtime tests proving valid create, invalid origin/content type/body size, one-time invite claim, second-claim rejection, unauthenticated socket rejection, authenticated socket snapshot, accepted move persistence, reconnect, and expiry.
- [ ] Run `npm test -- test/worker.integration.test.js`; verify RED because routes and Durable Object do not exist.
- [ ] Implement the router, CORS allowlist, deterministic room-to-object routing, hashed persisted capabilities, hibernatable socket attachments, role replacement on reconnect, storage writes, broadcasts, alarms, and sanitized errors.
- [ ] Run the integration test; verify GREEN, then run all domain tests.

### Task 4: Browser Online Transport

**Files:**
- Create: `src/online.js`
- Test: `test/online.test.js`
- Modify: `src/config.js`

**Interfaces:**
- Produces `OnlineRoomClient`, `parseInviteLocation(location)`, `buildInviteUrl(location, roomId, inviteToken)`, `validateServerMessage(value)`, `getOnlineApiUrl()`, and room-scoped session storage helpers.
- `OnlineRoomClient.create`, `.join`, `.connect`, `.sendMove`, `.resign`, and `.stop` expose callbacks without chess-rule ownership.

- [ ] Write failing tests using real `URL`, controlled storage, and a small fake WebSocket boundary for fragment parsing, invite URL generation under a GitHub Pages subpath, server message validation, no capability in socket URL, bounded reconnect, and room-scoped storage.
- [ ] Run `node --test test/online.test.js`; verify RED because the module does not exist.
- [ ] Implement transport with `VITE_ONLINE_API_URL`, `session.<capability>` WebSocket subprotocol, explicit connection states, and bounded exponential reconnect.
- [ ] Run the frontend transport test; verify GREEN.

### Task 5: Controller Online Mode

**Files:**
- Modify: `src/controller.js`
- Create: `test/online-controller.test.js`

**Interfaces:**
- Consumes: `OnlineRoomClient` and full server snapshots.
- Produces: `MODES.ONLINE`, `_startOnline(opts)`, `_onOnlineState(state)`, `_onlineHumanTurn()`, and server-intent move/resign flow.

- [ ] Write a focused controller harness that proves local board drops send intent without committing local FEN, canonical snapshots commit the board, wrong-turn input is locked, stale errors resync, and dispose stops reconnect/socket resources.
- [ ] Run `node --test test/online-controller.test.js`; verify RED on missing online mode.
- [ ] Add the online mode without changing legacy `MODES.REMOTE`; isolate online fields and lifecycle from Stockfish/Gist state.
- [ ] Run the controller test and existing test suite; verify GREEN.

### Task 6: Player-Facing Create, Join, and Lobby UI

**Files:**
- Modify: `src/main.js`
- Modify: `src/ui.js`
- Modify: `src/styles.css`
- Modify: `README.md`
- Test: `test/online-ui.test.js`

**Interfaces:**
- Consumes: controller online create/join operations and invite-link helpers.
- Produces accessible create/join forms, configuration-disabled state, copied invite link, automatic invite consumption, and truthful local room shortcuts.

- [ ] Write DOM-level behavior tests for no token input in player online flow, required player name, invite URL validation, disabled action without endpoint configuration, safe text rendering, copy-link feedback, and auto-join parsing.
- [ ] Run `npm test -- test/online-ui.test.js`; verify RED on current Gist-token UI.
- [ ] Change player-facing controls to `MODES.ONLINE`, retain legacy agent battle only in documentation/scripts, and update sandbox online settings without deleting unrelated user lobby edits.
- [ ] Run UI tests, all tests, and `npm run build`; verify GREEN.

### Task 7: Runtime and Release Proof

**Files:**
- Create: `.dev.vars.example`
- Modify: `.gitignore`
- Modify: `README.md`

**Interfaces:**
- Documents exact local commands and the public `VITE_ONLINE_API_URL`; deploy authentication stays outside the repository.

- [ ] Run `npm test`, `npm run build`, and `npx wrangler deploy --dry-run`; capture exit codes and first actionable warnings.
- [ ] Scan `dist`, tracked source, and config for `ghp_`, GitHub-token storage keys in player UI, raw test capabilities, Cloudflare API tokens, and accidental `.dev.vars` inclusion.
- [ ] Start Wrangler and Vite locally; use two isolated browser contexts to create/join, exchange at least four plies, reject a tampered illegal move, refresh/reconnect, and confirm equal room revision/FEN.
- [ ] Record proof level honestly: local Worker runtime is not public deployment proof. If Cloudflare authentication is available, deploy and repeat a two-client smoke test against the HTTPS Worker; otherwise provide the single required `wrangler login`/API-token handoff.
