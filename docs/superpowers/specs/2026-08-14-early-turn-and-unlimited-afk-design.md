# Early-turn and Unlimited AFK Design

## Scope

Add server-authoritative AFK adjudication to online user-versus-user rooms, play a dedicated AFK-loss sound, and remove every finished public room from lobby discovery immediately. Existing AI, AI-vs-AI, analysis, spectator, private-capability, and normal chess-result behavior stays unchanged.

The existing Home profile copy (`Guest Player`, `1500`, and the coming-soon account message) remains presentation-only and is outside this change. Lobby rooms, seats, clocks, spectators, AFK state, and game results remain real Worker state.

## Locked rules

### Opening AFK: only the first two plies

“Two turns” means the first two half-moves of the game:

1. White's first move (`moves.length === 0`).
2. Black's first move (`moves.length === 1`).

The opening AFK deadline starts when the room becomes active for White and restarts for Black after White's legal first move. If the side to move does not make a legal move before its deadline, that side loses. Once two legal moves exist (`moves.length >= 2`), opening AFK is permanently disabled and cannot reactivate after reconnect or reload.

Opening AFK limits:

| Time control | Limit |
| --- | ---: |
| 1 minute, 1+1 | 15 seconds |
| 3+1.5 | 20 seconds |
| 5 minutes | 25 seconds |
| 10 minutes | 30 seconds |
| 15 minutes | 35 seconds |
| 30 minutes | 40 seconds |
| Unlimited | 40 seconds |

Unlimited remains an untimed chess mode after opening. “Unlimited equals 30 minutes” applies only to selecting the 40-second opening/AFK countdown tier; it does not create a 30-minute chess clock.

### Unlimited AFK after the opening

This system runs only when `timeControlId === 'unlimited'` and `moves.length >= 2`.

- A player whose turn it is enters an AFK episode immediately when their active game tab reports `hidden`.
- A visible player who has not made a legal move for four minutes in the same turn enters an inactivity AFK episode.
- A visible heartbeat is sent every 10 seconds. If the Worker has not received a player heartbeat for 30 seconds while it is that player's turn, it treats the player as away and starts the same AFK episode. This covers a closed tab, lost socket, browser sleep, and a missed `visibilitychange` event.
- Each AFK episode uses a 40-second countdown.
- A hidden/heartbeat episode is cancelled when the same player's authenticated session reports visible again before expiry.
- An inactivity episode is cancelled only by a legal move; cursor, keyboard, focus, or heartbeat activity does not count as chess activity.
- A legal move always clears the outgoing player's active AFK episode and starts a fresh four-minute turn-inactivity window for the opponent.

The Worker records a strike when an episode starts:

1. First episode: strike 1 and a 40-second countdown.
2. Second episode: strike 2 and a 40-second countdown.
3. Third episode: immediate loss with no third countdown.

If either of the first two countdowns reaches zero, the AFK player loses immediately. Strikes belong to the player color for that room, survive reload/reconnect, and never decrease during the game. Duplicate hidden messages and repeated missed-heartbeat alarms within one active episode do not add strikes.

### Result contract

An AFK adjudication creates canonical final state:

- `status: 'finished'`
- winner derived from the losing color
- `reason: 'opening_afk_timeout'` for either opening deadline
- `reason: 'unlimited_afk_timeout'` when a 40-second unlimited episode expires
- `reason: 'unlimited_afk_strikes'` when the third episode starts
- revision incremented exactly once
- normal chess clock stopped when present
- AFK countdown cleared

The final snapshot is broadcast to both players and all spectators before lobby removal. Existing game-over UI renders a Thai win/loss popup with the AFK reason. All clients play `wet-fart-meme.mp3` only for these three AFK reasons; checkmate, draw, resignation, and normal chess-clock timeout keep their existing sounds.

## Authority and protocol

The browser never decides a loss, deadline, or strike. It sends only authenticated intent:

- `presence { visibility: 'visible' | 'hidden' }`
- `heartbeat { visibility: 'visible' | 'hidden' }`

Only host and guest sessions may send player presence. Spectators remain limited to `sync` and `ping`. Unknown fields and client-supplied colors, deadlines, strikes, results, or timestamps are rejected.

The room state stores bounded AFK authority sufficient for Durable Object hibernation and alarms: opening deadline, per-color strikes, current episode cause/color/start/deadline, current turn start, per-color visibility, and last heartbeat. Public state exposes only the current countdown needed by the UI plus each player's strike count; it does not expose session identifiers or capability material.

The client renders the Worker deadline against `Date.now()` and never persists a local winner. On visibility restoration it sends `visible`, requests `sync`, and resumes the canonical countdown. Reconnect sends current visibility immediately.

## Alarm scheduling

Each room keeps one Durable Object alarm at the earliest applicable authority boundary:

- room expiry;
- normal chess-clock timeout;
- opening AFK deadline;
- unlimited four-minute inactivity threshold;
- heartbeat-missing threshold;
- active AFK countdown deadline.

At alarm time the Worker reloads state, realizes every due transition once, persists and broadcasts changes, removes a newly finished public room from the lobby, then schedules the next boundary. Repeated alarms are idempotent.

## Lobby lifecycle

Every finish path—checkmate, draw, resignation, normal timeout, opening AFK timeout, unlimited AFK timeout, or third-strike loss—removes the public projection instead of upserting `finished`. The Durable Object keeps canonical final state and sessions until the existing room TTL, so connected clients receive the popup and reconnect can still read the result.

The lobby's next successful refresh receives a shorter room list. CSS Grid naturally reflows remaining cards into the vacated position. No tombstone, finished card, fake placeholder, or client-side deletion animation is required.

## Sound asset

Move `C:\Users\super\Downloads\wet-fart-meme.mp3` into `public/assets/sounds/wet-fart-meme.mp3`. The source file is removed from Downloads only after the destination has been copied and byte-for-byte verified. Register it as the `afk` sound without changing existing sound mappings.

## Failure handling

- A client that never reports visibility cannot avoid heartbeat enforcement; missing heartbeat becomes away after 30 seconds on its turn in Unlimited mode.
- A delayed hidden/visible message cannot override a finished game or change another player's AFK episode.
- A stale authenticated socket may report only its own presence; color comes from its server attachment.
- Clock timeout and AFK deadline at the same timestamp are resolved once using the earliest applicable rule: opening AFK during the first two plies, then normal clock; after the opening only the normal clock applies to timed modes.
- Registry removal failure does not roll back a finished game. It is retried through the existing queued registry operation, while lobby list filtering also excludes any legacy `finished` row.
- Audio playback failure never blocks the popup or result.

## Verification

### Domain and protocol

- Every time-control ID maps to the exact opening limit.
- Only plies zero and one receive opening deadlines.
- A legal second move permanently disables opening AFK.
- Unlimited inactivity starts at four minutes and countdown expires at 40 seconds.
- Hidden/visible recovery creates one strike per distinct episode; the third episode loses immediately.
- Duplicate messages and alarms cannot double-increment revision or strikes.
- Presence/heartbeat schemas reject spectator use and client authority fields.

### Worker integration

- Opening timeout broadcasts one final snapshot and removes the room from lobby listing.
- Checkmate, draw, resignation, and normal timeout also remove the projection.
- Unlimited hidden, visible recovery, missed heartbeat, four-minute inactivity, two recoveries, and third-strike loss work across reconnect.
- Spectator mutation boundaries remain unchanged.

### Frontend and browser

- Countdown and strike state come from canonical snapshots.
- Popup reason is distinguishable for opening timeout, countdown expiry, and third strike.
- AFK sound is selected only for AFK results.
- After a room finishes, the next lobby refresh removes its card and remaining cards reflow.
- Two independent player tabs plus a spectator see the same final state; refresh cannot revive the game.

