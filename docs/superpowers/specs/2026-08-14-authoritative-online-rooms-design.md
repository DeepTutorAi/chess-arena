# Authoritative Online Rooms Design

## Outcome

Chess Arena gains a real invite-only human-versus-human mode. A player creates a room, sends a link, and a second player joins without supplying a GitHub token. A Cloudflare Worker routes each room to one SQLite-backed Durable Object, which owns the canonical chess position and validates every move with `chess.js`.

The existing GitHub Gist protocol remains available to terminal AI clients as a legacy agent-battle feature. It is not used by the new player-facing online flow.

## Scope

The first production slice includes:

- Create an invite-only room with a title, player name, color preference, initial position, and existing time-control choice.
- Copy an invite link containing an unguessable room identifier and a one-time invite capability in the URL fragment.
- Claim the guest seat once, then reconnect either player with a room-scoped session capability stored only in that browser.
- Synchronize waiting, active, finished, and disconnected state through WebSockets.
- Validate turn ownership, legal chess moves, promotion, game-over result, monotonic revision, and clocks on the server.
- Expire abandoned room data after 24 hours and reject new activity after expiry.
- Show explicit connection/error/reconnect states; never present a local record as a live room.

This slice does not include public room discovery, accounts, ratings, matchmaking, spectators, chat, or anti-abuse services that require a paid plan.

## Architecture

The static Vite app remains deployable to GitHub Pages. Its only production configuration is the public Worker origin in `VITE_ONLINE_API_URL`; no deploy credential or private token enters the Vite bundle.

The Worker exposes narrowly scoped HTTP endpoints:

- `POST /api/rooms` creates a room and returns `{ roomId, sessionToken, inviteUrlToken, state }`.
- `POST /api/rooms/:roomId/join` consumes the one-time invite token and returns `{ sessionToken, state }`.
- `GET /api/rooms/:roomId/socket` upgrades to WebSocket. Authentication uses a `session.<token>` WebSocket subprotocol so the capability is not placed in the request URL.

The top-level Worker validates method, path, content type, body size, CORS origin, and identifiers before forwarding to the room Durable Object. The Durable Object hashes capabilities with SHA-256 before persistence, stores canonical room state in SQLite-backed storage, and uses hibernatable WebSockets. One room identifier always maps to one Durable Object, serializing all moves for that game.

## Room and Session Contract

Room identifiers contain 16 lowercase base32 characters. Session and invite capabilities contain at least 256 bits of randomness and are compared by SHA-256 digest. The raw host/guest session capability is returned only once and retained by that browser under a key scoped to the room. The raw invite capability appears after `#invite=` so normal page navigation and static hosting do not transmit it.

The host chooses white, black, or random. The guest receives the opposite color. A room is `waiting` before the guest claims the invite, `active` once both seats exist, and `finished` after checkmate, draw, resignation, or timeout.

Client commands are JSON objects with protocol `chess-arena-online`, version `1`, and a `type`:

- `move`: `{ from, to, promotion?, expectedRevision }`
- `resign`: `{ expectedRevision }`
- `sync`: no mutable state; asks the server to resend canonical state
- `ping`: liveness only

The server never accepts FEN, turn, result, clock values, player color, or move history from a client after room creation.

## Canonical State

Every broadcast uses a full snapshot so reconnect and out-of-order client rendering are deterministic:

```json
{
  "protocol": "chess-arena-online",
  "version": 1,
  "type": "state",
  "roomId": "example",
  "revision": 3,
  "status": "active",
  "fen": "...",
  "turn": "b",
  "lastMove": "e2e4",
  "lastMoveSan": "e4",
  "moves": ["e2e4"],
  "result": null,
  "reason": null,
  "players": {
    "w": { "name": "A", "connected": true },
    "b": { "name": "B", "connected": true }
  },
  "clock": {
    "initialMs": 300000,
    "incrementMs": 0,
    "whiteMs": 300000,
    "blackMs": 300000,
    "activeSince": 1786630000000
  },
  "expiresAt": 1786716400000
}
```

Names are trimmed plain text, limited to 40 Unicode code points, and rendered with `textContent`. Titles are limited to 80 code points. Initial FEN must be accepted by `chess.js`; the standard position is the default.

## Move and Clock Rules

For a move, the Durable Object loads canonical state, authenticates the socket attachment, confirms `active` status and matching revision, realizes elapsed clock time, confirms the caller owns the side to move, and calls `Chess.move`. A rejected command leaves storage unchanged and returns a typed error plus the latest snapshot.

For timed games, `activeSince` is set when the guest joins. On each accepted move the mover's elapsed time is deducted, increment is added, the next side becomes active, and an alarm is scheduled for the next timeout. The alarm reloads state, realizes elapsed time, marks the timeout result, stores it, and broadcasts it. Unlimited games have `clock: null` and no timeout alarm.

## Client Integration

`src/online.js` owns HTTP/WebSocket transport, room-scoped capability storage, protocol validation, retry with bounded exponential backoff, and callbacks. It does not own chess rules.

`Controller` gains `MODES.ONLINE` and online-specific state. It loads only server snapshots, permits board interaction only when connected, active, revision-current, and the local player's turn, and sends move intent without mutating canonical game state first. Accepted snapshots update `Chess`, move list, player bars, clocks, status, and board. Rejected moves resynchronize without optimistic drift.

The create dialog removes the GitHub-token field from the player flow and asks for display name, room title, color, and time control. The join flow accepts an invite URL or automatically consumes `?room=<id>#invite=<capability>`. Locally stored room records are labeled history/shortcut records, while live state always comes from the Worker.

## Failure and Security Behavior

- Missing production Worker configuration disables create/join with a truthful configuration message.
- Invalid/used invite capabilities return a generic unauthorized response.
- Invalid session, origin, payload, square, promotion, stale revision, wrong turn, finished room, and oversized requests are rejected explicitly.
- WebSocket reconnect reuses only the room-scoped session capability and requests a canonical snapshot.
- A room has at most two authenticated player sockets by role; a reconnect replaces the older socket for that role.
- Logs must not include raw capabilities, URL fragments, player names, full request bodies, or raw error objects.
- CORS is an allowlist configured through `ALLOWED_ORIGINS`; localhost is accepted only by local development configuration.
- Room expiry and payload limits bound storage and request amplification. Public lobby and anonymous spectators remain out of scope.

## Verification Gates

Completion requires all of the following evidence:

1. Unit tests demonstrate legal move acceptance and rejection of illegal, wrong-turn, stale-revision, unauthorized, expired, and post-finish commands.
2. Worker-runtime tests demonstrate create, one-time join, authenticated WebSocket state, reconnect, and persistence through Durable Object storage.
3. Server clock tests demonstrate elapsed-time deduction, increment, and timeout result.
4. Frontend protocol tests demonstrate invite parsing, capability isolation, snapshot validation, and reconnect behavior.
5. Vite build succeeds and release output contains no GitHub token key, sample private token, invite capability, or deploy credential.
6. Local runtime proof uses two independent browser contexts to create, join, exchange moves, reject a tampered move, refresh/reconnect, and observe the same final revision.
7. Deployment is reported separately: local proof does not claim a public Worker exists until `wrangler deploy` succeeds and the deployed endpoint is exercised.
