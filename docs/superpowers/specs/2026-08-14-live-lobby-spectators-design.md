# Chess Arena Live Lobby and Spectators Design

**Date:** 2026-08-14
**Status:** Approved direction

## Outcome

Replace the invite-entry-first Join screen with a real server-backed lobby that lists multiple live rooms. Players can join public rooms from a card without seeing or pasting a link. Room owners may still create private rooms and share an invite link. Active games can allow read-only spectators whose presence is visible from the board through an eye icon and a profile list.

The existing server-authoritative move model remains the authority. Lobby cards, occupancy, and spectator counts must come from the Worker runtime, never fabricated fixtures or localStorage.

## Product decisions

- New rooms are public by default; creators can select private.
- Public waiting rooms appear in the lobby and can be joined directly.
- Public games may remain visible as watchable cards after both seats are filled.
- Private rooms never appear in public discovery. Creation returns separate player-invite and watch-invite capabilities so sharing watch access never grants a player seat.
- The invitation link remains available from the room screen as a secondary action; it is not shown as the primary Join UI.
- Display names are lightweight guest identities in this version. There is no account, rating, or authenticated identity claim.
- Avatars are deterministic chess-themed icons derived from an ephemeral public profile seed. They must not imply a verified account.
- Spectators are read-only. They cannot move, resign, claim a seat, alter clocks, or send canonical game state.
- Lobby discovery and spectator presence are bounded for the Cloudflare Free architecture.

## User flows

### Browse and join a public room

1. The user opens `JOIN GAME`.
2. The client fetches a first page of authoritative lobby summaries.
3. The page shows Open and Watchable rooms in a responsive card grid.
4. The user enters a display name once. It is reused locally as a convenience, not identity proof.
5. Pressing `JOIN` atomically claims the open player seat and opens the board.
6. If another player claimed the seat first, the card changes to `WATCH` or disappears on refresh; the UI reports the conflict without optimistic success.

### Create a room

1. The creator chooses name, side, time control, title, and Public or Private visibility.
2. Public rooms are registered only after the room Durable Object is created successfully.
3. The creator enters the waiting board and can copy an invite from a secondary Share action.
4. Private rooms are omitted from public discovery and remain accessible by their capability-bearing link.

### Watch a game

1. A user presses `WATCH` on an active public room or opens a valid capability-bearing private watch link.
2. The user selects a display name and one of the provided chess avatars.
3. The Room Durable Object issues a spectator session scoped to that room.
4. The spectator receives canonical snapshots and presence changes over WebSocket.
5. The board is non-movable. Player-only actions are absent.
6. An eye icon shows the current count. Activating it opens an accessible popover or bottom sheet with spectator profiles.

### Reconnect

- Player sessions continue to use room-scoped local session capabilities.
- Spectator sessions are also room-scoped and may reconnect until the room expires.
- Recent rooms remain a separate `Recent / Reconnect` section and are never mixed with the authoritative public room list.

## Lobby UI

The visual direction is a restrained “Night Tournament Hall” integrated with the existing park background.

### Header

- Back button and `Chess Arena Online` identity.
- Compact live indicator and number of discoverable rooms returned by the server.
- Primary `CREATE ROOM` action.
- Display-name control, persisted only as a browser convenience.

### Discovery controls

- Tabs: `ALL`, `OPEN`, and `WATCH`.
- Time-control filter: All, Bullet, Blitz, Rapid, Unlimited.
- Search matches room title or host display name on the currently fetched summaries.
- A refresh action and last-updated text; no fake live status.
- The first implementation uses bounded refresh with visibility-aware polling. WebSocket lobby fan-out is deferred unless polling creates measured pressure.

### Room cards

Each card shows only server-provided facts:

- chess-themed emblem;
- room title and public status;
- host display name and deterministic avatar;
- time control;
- available side or both player names;
- `1/2`, `2/2`, and spectator count;
- age bucket such as `just now`, `2m`, or `18m` derived from server timestamp;
- `JOIN`, `WATCH`, `RECONNECT`, or disabled `ENDED` action.

Cards use a common dark glass body and one accent family per real room state: green for Open, gold for Active/Watch, muted steel for Ended. Color is never the only status signal.

### Empty, loading, and failure states

- Loading uses a small fixed number of skeleton cards, explicitly non-interactive.
- Empty state says no public rooms are waiting and offers Create Room.
- Network failure retains no stale cards as live truth. A labelled stale snapshot may remain visible only with disabled actions and a Retry control.
- Recent rooms are local shortcuts labelled `RECENT`, never `LIVE` until a room connection succeeds.

### Responsive behavior

- Desktop: three-column grid when space permits, two columns on medium widths.
- Mobile: one-column cards, sticky compact filters, and full-width primary actions.
- The spectator profile list becomes a bottom sheet on narrow screens.
- Keyboard focus order follows header, filters, room cards, then recent rooms.

## Game-screen spectator UI

- Add an eye button near the online connection/status area, not over the chessboard.
- Label format: eye icon plus count, with accessible text such as `ผู้ชม 7 คน`.
- Clicking opens a profile panel with deterministic avatar, display name, and `Watching` state.
- Player profiles remain visually distinct from spectators.
- No rating, country, account badge, online history, or verified identity is invented.
- When the count is zero, the eye remains available with `ยังไม่มีผู้ชม` only for public/watch-enabled games; private non-watchable games hide it.
- Spectator join/leave announcements may appear in the local signal log but do not enter chess move history.

## Visual assets

Use generated assets only where they create identity that CSS and existing icons cannot provide efficiently.

### Generate

- One transparent atlas or individual transparent WebP/PNG files containing six chess emblems: Knight, Crowned King, Rook Tower, Moon Bishop, Twin Pawns, and Royal Shield.
- One wide, low-contrast Night Tournament Hall header illustration that harmonizes with the existing park image and remains legible behind text.
- One transparent empty-lobby illustration of an unoccupied chess table at night.

### Do not generate

- Per-room background images.
- Fake player portraits.
- Rating badges or flags.
- Text baked into images.
- Heavy animated video or large textures.

CSS supplies glass panels, gradients, state accents, hover motion, skeletons, and ambient particles. Generated assets must be compressed, responsive, and decorative (`alt=""`) where they convey no unique information.

## Backend architecture

### Durable Objects

Keep one `ChessRoom` Durable Object per game and add a singleton `LobbyRegistry` Durable Object.

`LobbyRegistry` owns bounded public discovery metadata only:

- room ID;
- title;
- public status and visibility;
- host and guest public profile summaries;
- time-control summary;
- open side;
- created and updated timestamps;
- spectator count;
- discoverability expiry.

It stores no player session token, invite capability, raw WebSocket protocol, private room, or canonical move history.

`ChessRoom` remains authoritative for seats, moves, result, clocks, sessions, and live spectator presence. Lobby summaries are projections and may lag briefly; all Join and Watch actions are revalidated atomically by the room.

### HTTP API

- `GET /api/lobby?status=all|open|watch&cursor=...` returns bounded public summaries and a cursor.
- `POST /api/rooms` accepts `visibility` and `allowSpectators`.
- `POST /api/rooms/:id/join-public` claims an open public seat without exposing an invite token.
- Existing invite join remains for private/direct-link use.
- `POST /api/rooms/:id/watch` creates a spectator session after validating room visibility or a dedicated private watch capability.
- Existing player socket route accepts player sessions; the socket handshake resolves the session role server-side.

Lobby pages are capped at 24 cards. The client requests another page explicitly; it never downloads an unbounded registry.

### Registry consistency

- Room creation writes the room first, then registers a public projection.
- Seat claim, game start, result, visibility change, spectator count bucket change, and expiry trigger idempotent projection updates.
- The registry removes expired records lazily during listing and by scheduled/alarm cleanup.
- A registry entry is never enough to authorize Join or Watch.
- Failure to update the registry does not corrupt game state. The room retries projection updates, and stale cards fail safely when revalidated.

### Spectator sessions and presence

- Spectator capability is random, room-scoped, stored as a digest, and never placed in a query string.
- The room maintains bounded public spectator profiles for currently connected spectator sockets. Session capability state survives a disconnect for reconnect, but disconnected profiles are not counted or listed.
- Default limit: 50 concurrent spectators per room.
- Profile names use the same validated display-name rules as players.
- Avatar choice is restricted to a server-known enum; clients cannot submit image URLs or markup.
- Multiple sockets using the same spectator session replace the older socket, matching player reconnect behavior.
- Presence broadcasts are debounced/coalesced to avoid update storms.

## Security and abuse boundaries

- Public listing discloses only the explicitly public room/profile fields above.
- Private room IDs and metadata are never enumerable.
- Join is race-safe and server-authoritative.
- Spectator commands are allowlisted to `sync` and `ping`; player commands from spectator sessions return `unauthorized_role`.
- Validate all title/name/filter/cursor lengths and shapes.
- Bound request bodies, lobby page size, room lifetime, registry size per cleanup window, spectator count, and reconnect attempts.
- Use same-origin/CORS enforcement already present.
- Add lightweight per-room action throttling for repeated public join/watch issuance. Infrastructure-wide anti-bot controls are a later production hardening layer, not simulated in UI.
- Never expose capability digests or raw capabilities in lobby summaries, logs, telemetry, or generated assets.

## Failure behavior

- `room_full`: convert Join to Watch when allowed, after explicit user action; never silently change roles.
- `room_not_public`: remove the stale card and explain that the room is no longer public.
- `spectators_disabled` or `spectator_limit`: retain game card but disable Watch with a truthful reason.
- Lobby unavailable: Create by private link may remain available only if the room service itself is healthy; label discovery unavailable.
- Projection update failure: game continues; retry projection asynchronously without claiming lobby freshness.
- Disconnect: show reconnect state and preserve the last canonical board as stale, with moves disabled for players and spectators alike.

## Testing and acceptance evidence

### Domain and Worker tests

- Public rooms register and list; private rooms never list.
- Cursor/page limits and malformed filters are enforced.
- Two or more rooms can be listed with distinct authoritative summaries.
- Public Join claims one seat exactly once under a race.
- Full public games expose Watch only when enabled.
- Spectator sessions receive state and presence but cannot move, resign, or mutate revision.
- Spectator reconnect replaces the old socket and preserves profile identity.
- Spectator count and profile list update on join/leave and respect the cap.
- Room expiry and game result update or remove registry projections.
- Registry projection failure cannot corrupt canonical room state.

### Frontend tests

- Lobby cards render only validated server summaries.
- Loading, empty, stale, error, Open, Watch, Reconnect, and Private-link flows are distinguishable.
- Search and filters never invent results.
- Join conflicts are handled without optimistic board entry.
- Spectator view locks the board and hides player-only controls.
- Eye button count, accessible name, popover focus, Escape dismissal, and mobile sheet behavior work.
- Generated asset failure falls back to a semantic chess glyph without breaking room actions.

### Browser proof

- Create at least three public rooms and one private room in independent browser contexts.
- Verify only public rooms appear and each card reflects the correct host/time/status.
- Join one public room directly from its card without copying or displaying an invite URL.
- Start a game, enter with at least two spectator contexts, and verify eye count/profile list on both players.
- Attempt a spectator move through the protocol and verify server rejection and unchanged revision/FEN.
- Reload one player and one spectator and verify reconnect.
- Confirm responsive layout at desktop and mobile widths and no console errors.

## Delivery boundaries

This phase does not add accounts, ratings, chat, matchmaking ratings, friends, moderation dashboards, or permanent user profiles. The UI must not imply those systems exist. The design creates extension points for future authenticated profiles without coupling the lobby to fabricated identity data.
