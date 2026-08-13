# Online AFK Adjudication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-authoritative opening and Unlimited-mode AFK losses, canonical countdown UI and sound, and immediate removal of every finished public room from lobby discovery.

**Architecture:** Introduce a focused `worker/afk-state.js` domain module that owns AFK limits, episodes, strikes, transitions, and next deadlines without trusting browser timestamps. `ChessRoom` combines that domain with its existing Durable Object alarm and authenticated WebSocket attachments; the browser sends only visibility/heartbeat intent and renders canonical public AFK state. Finished games remain in room storage for popup/reconnect but use registry removal rather than a finished projection.

**Tech Stack:** JavaScript ES modules, Cloudflare Workers and SQLite Durable Objects, WebSocket hibernation attachments, Node test runner, Vitest Workers pool, Vite 7, browser Page Visibility API, HTML Audio.

## Global Constraints

- Opening AFK applies only while `moves.length` is `0` or `1`; it can never reactivate at `moves.length >= 2`.
- Limits are literal: 1/1+1 = 15s, 3+1.5 = 20s, 5 = 25s, 10 = 30s, 15 = 35s, 30/Unlimited = 40s.
- Unlimited remains clockless; its 30-minute equivalence chooses only the 40-second AFK tier.
- Unlimited post-opening inactivity starts after four minutes; player heartbeats are every 10 seconds and are considered missing after 30 seconds.
- Episode 1 and 2 each get 40 seconds; episode 3 loses immediately. Duplicate signals in one episode never add strikes.
- Browser input never owns color, timestamps, deadlines, strikes, results, or winner.
- Spectators cannot send player presence or heartbeat commands.
- Every finish path removes the public lobby projection after broadcasting final state; room storage remains until existing TTL.
- Move and byte-verify `C:\Users\super\Downloads\wet-fart-meme.mp3` as `public/assets/sounds/wet-fart-meme.mp3`.
- Preserve `.battle-room-id.txt`, `.serena/`, and `docs/firebase_roadmap.md` unstaged and unchanged.
- Add no runtime dependency.

---

### Task 1: Pure AFK domain transitions

**Files:**
- Create: `worker/afk-state.js`
- Create: `test/afk-state.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `openingAfkLimitMs(timeControlId): number`.
- Produces: `createAfkState(timeControlId, now): AfkState`.
- Produces: `advanceAfkAfterMove(state, now): GameState`.
- Produces: `applyPlayerPresence(state, color, visibility, now): { changed, state }`.
- Produces: `applyPlayerHeartbeat(state, color, visibility, now): { changed, state }`.
- Produces: `realizeAfk(state, now): { changed, state }`.
- Produces: `nextAfkDeadline(state): number | null` and `toPublicAfk(state): object`.

- [ ] **Step 1: Write failing literal limit and opening-boundary tests**

Create table-driven tests with hand-derived values:

```js
const limits = [
  ['bullet_1_0', 15_000], ['bullet_1_1', 15_000],
  ['blitz_3_1_5', 20_000], ['blitz_5_0', 25_000],
  ['rapid_10_0', 30_000], ['rapid_15_0', 35_000],
  ['classical_30_0', 40_000], ['unlimited', 40_000],
];
for (const [id, want] of limits) assert.equal(openingAfkLimitMs(id), want);

const afk = createAfkState('bullet_1_0', 1_000);
assert.equal(afk.openingDeadlineAt, 16_000);
```

Exercise a first legal move through a fixture with one UCI move and assert Black's deadline is `now + limit`; exercise two moves and assert `openingDeadlineAt === null` permanently.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/afk-state.test.js`

Expected: FAIL because `worker/afk-state.js` does not exist.

- [ ] **Step 3: Implement minimal AFK state shape and opening transition**

Use a bounded serializable shape:

```js
{
  openingLimitMs,
  openingDeadlineAt,
  turnStartedAt,
  strikes: { w: 0, b: 0 },
  episode: null,
  presence: {
    w: { visibility: 'visible', lastHeartbeatAt: now },
    b: { visibility: 'visible', lastHeartbeatAt: now },
  },
}
```

`advanceAfkAfterMove` derives the next opening deadline from `state.moves.length`, never from a client field.

- [ ] **Step 4: Write failing Unlimited episode tests**

Assert these independent behaviors with literal timestamps:

```js
// Hidden starts strike 1 and a 40-second deadline.
assert.deepEqual(result.state.afk.episode, {
  color: 'w', cause: 'hidden', startedAt: 10_000, deadlineAt: 50_000,
});
assert.equal(result.state.afk.strikes.w, 1);

// Visible recovery clears the episode but preserves strike 1.
// A duplicate hidden while the episode exists does not become strike 2.
// A second recovered episode becomes strike 2.
// A third distinct trigger finishes immediately with unlimited_afk_strikes.
```

Add four-minute visible inactivity at `turnStartedAt + 240_000`, missed heartbeat at `lastHeartbeatAt + 30_000`, expiry at `episode.deadlineAt`, and legal-move cancellation. Assert timed modes never start post-opening episodes.

- [ ] **Step 5: Run focused tests and verify expected RED branches**

Run: `node --test test/afk-state.test.js`

Expected: opening tests PASS; Unlimited episode assertions FAIL because transitions are not implemented.

- [ ] **Step 6: Implement Unlimited transitions and canonical finish**

Implement one episode-start helper that increments a strike once and either creates the 40-second episode or finishes on strike 3. Canonical finish must set:

```js
next.status = 'finished';
next.result = loser === 'w' ? '0-1' : '1-0';
next.reason = reason;
next.revision += 1;
next.updatedAt = now;
next.afk.episode = null;
if (next.clock) next.clock.activeSince = null;
```

`realizeAfk` first expires an existing episode, then starts only one due inactivity/heartbeat episode. `nextAfkDeadline` returns the earliest applicable server timestamp.

- [ ] **Step 7: Verify domain GREEN and register the test**

Run: `node --test test/afk-state.test.js`

Expected: all AFK domain tests PASS. Add `test/afk-state.test.js` to `test:domain`, then run `npm run test:domain` and expect the complete domain suite to pass.

- [ ] **Step 8: Commit domain checkpoint**

```powershell
git add -- worker/afk-state.js test/afk-state.test.js package.json
git commit -m "feat: define authoritative afk transitions"
```

---

### Task 2: Integrate AFK state with chess moves and public snapshots

**Files:**
- Modify: `worker/game-state.js`
- Modify: `test/game-state.test.js`
- Modify: `src/online.js`
- Modify: `test/online.test.js`

**Interfaces:**
- Consumes: `createAfkState`, `advanceAfkAfterMove`, and `toPublicAfk` from Task 1.
- Extends public state with `afk: { strikes: { w, b }, countdown: null | { color, cause, deadlineAt } }`.

- [ ] **Step 1: Write failing game-state AFK lifecycle tests**

Assert waiting state has `afk: null`; joining creates White's opening deadline; White's first legal move creates Black's deadline; Black's first legal move clears it; later moves leave it cleared. Assert a checkmate/resignation clears any episode and public state contains no internal heartbeat timestamps.

- [ ] **Step 2: Run game-state test and verify RED**

Run: `node --test test/game-state.test.js`

Expected: FAIL because game state does not yet own `afk`.

- [ ] **Step 3: Connect AFK lifecycle to existing state mutations**

- `createGameState`: set `afk: null` while waiting.
- `joinGameState`: call `createAfkState(next.timeControlId, now)` after activation.
- `applyGameCommand`: after a legal move and clock update, call `advanceAfkAfterMove(next, now)`.
- Every chess finish clears `next.afk.episode` and opening deadline.
- `toPublicState`: emit only `toPublicAfk(state)`.

- [ ] **Step 4: Tighten browser trust-boundary validation with failing tests**

Extend the canonical `validState()` fixture and assert rejection of negative strikes, unknown causes, mismatched countdown shape, extra AFK authority fields such as `lastHeartbeatAt`, and a deadline that is not a safe integer.

- [ ] **Step 5: Run online validation test and verify RED**

Run: `node --test test/online.test.js`

Expected: FAIL because `validateServerMessage` does not validate `afk`.

- [ ] **Step 6: Implement strict public AFK validation**

Allow only:

```js
{
  strikes: { w: 0..2, b: 0..2 },
  countdown: null | {
    color: 'w' | 'b',
    cause: 'opening' | 'hidden' | 'heartbeat' | 'inactivity',
    deadlineAt: Number.isSafeInteger,
  },
}
```

Reject unknown keys at every level.

- [ ] **Step 7: Verify lifecycle and validation GREEN**

Run: `node --test test/game-state.test.js test/online.test.js`

Expected: all tests PASS.

- [ ] **Step 8: Commit integration checkpoint**

```powershell
git add -- worker/game-state.js test/game-state.test.js src/online.js test/online.test.js
git commit -m "feat: expose canonical afk game state"
```

---

### Task 3: Authenticated presence protocol and Durable Object alarms

**Files:**
- Modify: `worker/protocol.js`
- Modify: `test/protocol.test.js`
- Modify: `worker/room.js`
- Modify: `test/worker.integration.test.js`

**Interfaces:**
- Extends `parseSocketCommand` with exact commands `{ type: 'presence', visibility }` and `{ type: 'heartbeat', visibility }`.
- Consumes: `applyPlayerPresence`, `applyPlayerHeartbeat`, `realizeAfk`, and `nextAfkDeadline`.

- [ ] **Step 1: Write failing protocol tests**

Accept exactly:

```js
{ type: 'presence', visibility: 'visible' }
{ type: 'presence', visibility: 'hidden' }
{ type: 'heartbeat', visibility: 'visible' }
```

Reject client fields including `color`, `now`, `deadlineAt`, `strikes`, `result`, and unknown visibility values.

- [ ] **Step 2: Verify protocol RED, implement parser, verify GREEN**

Run before and after implementation: `node --test test/protocol.test.js`

Expected: first run FAIL on unknown commands; second run PASS after adding the two exact schemas.

- [ ] **Step 3: Write failing Worker integration tests for opening alarms**

Create a room for each representative tier, join it, read its Durable Object state/alarm, invoke the alarm at the opening deadline, and assert one final broadcast with `reason: 'opening_afk_timeout'`. Assert the room disappears from `/api/lobby` while `/sync` still returns the final state.

- [ ] **Step 4: Write failing Unlimited presence/strike integration tests**

Using real Worker WebSockets:

- complete two legal opening moves;
- send authenticated host `hidden`, then `visible`, and assert strike 1 persists;
- repeat for strike 2;
- send the third hidden and assert immediate `unlimited_afk_strikes` loss;
- in separate rooms assert four-minute inactivity and missed heartbeat start a countdown;
- assert countdown expiry gives `unlimited_afk_timeout`;
- assert spectator `presence` and `heartbeat` receive `unauthorized_role` with unchanged revision/FEN.

- [ ] **Step 5: Run focused Worker tests and verify RED**

Run: `npx vitest run test/worker.integration.test.js -t "AFK|afk"`

Expected: FAIL because the room ignores player presence and schedules only clock/expiry alarms.

- [ ] **Step 6: Implement authenticated AFK message handling**

In `webSocketMessage`:

1. Parse command.
2. Reject presence/heartbeat when `attachment.role === 'spectator'`.
3. Derive color from `attachment.color`.
4. Call the matching pure transition with `Date.now()`.
5. Persist only changed state, broadcast canonical state, and reschedule the alarm.

Keep `ping`/`sync`, move, resign, and spectator behavior intact.

- [ ] **Step 7: Integrate AFK realization and earliest-deadline alarm**

At join/move/presence/alarm boundaries schedule:

```js
const deadlines = [state.expiresAt, nextAfkDeadline(state), normalClockDeadline]
  .filter(Number.isSafeInteger);
await this.ctx.storage.setAlarm(Math.min(...deadlines));
```

At alarm, call `realizeAfk` before normal `realizeTimeout` during the first two plies. Persist/broadcast only once per transition. Finished state schedules room expiry only.

- [ ] **Step 8: Remove all finished rooms from discovery**

Change registry synchronization so `state.status === 'finished'` calls `/remove` rather than `/upsert`. Ensure the command path that receives `result.state` from a timeout queues this removal. Add `status != 'finished'` as a defensive `LobbyRegistry.list` condition and a registry test proving a legacy finished row is omitted.

- [ ] **Step 9: Verify Worker GREEN**

Run: `npm run test:worker`

Expected: all lobby registry and Worker integration tests PASS without unhandled socket/alarm errors.

- [ ] **Step 10: Commit Worker checkpoint**

```powershell
git add -- worker/protocol.js worker/room.js worker/lobby-registry.js test/protocol.test.js test/worker.integration.test.js test/lobby-registry.test.js
git commit -m "feat: enforce afk outcomes in online rooms"
```

---

### Task 4: Browser visibility heartbeat and canonical countdown UI

**Files:**
- Modify: `src/online.js`
- Modify: `src/controller.js`
- Modify: `src/ui.js`
- Modify: `src/styles.css`
- Modify: `test/online.test.js`
- Modify: `test/online-controller.test.js`
- Create: `test/afk-ui.test.js`
- Modify: `package.json`

**Interfaces:**
- `OnlineRoomClient` accepts injected `document`, `setIntervalImpl`, and `clearIntervalImpl` for real behavior tests.
- Player sockets send immediate presence on open and heartbeat every 10,000ms; `stop()` removes listener and timer.
- `UI.setAfkCountdown({ visible, label, seconds, strikes })` renders an accessible warning without claiming a local result.

- [ ] **Step 1: Write failing client lifecycle tests**

Use the existing fake WebSocket plus a real `EventTarget`-compatible document fixture. Assert a host socket sends `{type:'presence', visibility:'visible'}` on open, sends heartbeat at 10 seconds, sends hidden on `visibilitychange`, sends visible plus `sync` on restoration, and removes timers/listeners on stop. Assert spectator sessions send none of these player commands.

- [ ] **Step 2: Run online client test and verify RED**

Run: `node --test test/online.test.js`

Expected: FAIL because the client has no visibility lifecycle.

- [ ] **Step 3: Implement minimal visibility lifecycle**

Derive visibility from `document.visibilityState === 'hidden' ? 'hidden' : 'visible'`. Start only after a player WebSocket opens. Never put time, color, strike, or result in the payload. On visible restoration send presence followed by `sync`.

- [ ] **Step 4: Write failing controller and DOM countdown tests**

Assert canonical snapshots produce:

- opening text `ต้องเดินภายใน 15 วินาที`;
- hidden/heartbeat/inactivity text and `Strike 1/2`;
- countdown decrements from Worker `deadlineAt` using injected/current time;
- no countdown when `countdown === null`;
- no popup before canonical `status: finished`;
- `opening_afk_timeout`, `unlimited_afk_timeout`, and `unlimited_afk_strikes` each produce distinct Thai detail.

- [ ] **Step 5: Run UI tests and verify RED**

Run: `node --test test/online-controller.test.js test/afk-ui.test.js`

Expected: FAIL because no AFK warning surface or result copy exists.

- [ ] **Step 6: Implement accessible countdown rendering**

Add a compact warning above the existing online status/sidebar, with `role="status"`, `aria-live="polite"`, cause label, whole seconds rounded up, and the current player's strike count. Update at 250ms from canonical deadline; clear interval and hide on state change/dispose.

- [ ] **Step 7: Implement canonical AFK result copy**

Map reasons:

```js
opening_afk_timeout: 'ไม่เดินหมากภายในเวลาช่วงเปิดเกม',
unlimited_afk_timeout: 'หมดเวลานับถอยหลัง AFK',
unlimited_afk_strikes: 'AFK ครบ 3 ครั้ง',
```

Keep title based on canonical result and viewer role. Spectators see neutral `เกมจบแล้ว`; players see `คุณชนะ/คุณแพ้`.

- [ ] **Step 8: Verify frontend GREEN**

Run: `npm run test:domain && npm run build`

Expected: all domain/UI tests and production build PASS.

- [ ] **Step 9: Commit frontend checkpoint**

```powershell
git add -- src/online.js src/controller.js src/ui.js src/styles.css test/online.test.js test/online-controller.test.js test/afk-ui.test.js package.json
git commit -m "feat: show canonical online afk countdowns"
```

---

### Task 5: Move and register the AFK loss sound

**Files:**
- Move: `C:\Users\super\Downloads\wet-fart-meme.mp3` → `public/assets/sounds/wet-fart-meme.mp3`
- Modify: `src/sounds.js`
- Modify: `test/online-controller.test.js`

**Interfaces:**
- Adds sound key `afk: 'wet-fart-meme.mp3'`.
- AFK reasons select `sounds.play('afk')`; every non-AFK result preserves existing selection.

- [ ] **Step 1: Write failing sound-selection tests**

Spy at the controller's sound boundary and feed canonical finished snapshots for all three AFK reasons plus checkmate, draw, resignation, and normal timeout. Assert only AFK reasons select `afk`; existing reasons select `victory`, `lose`, or `draw` as before.

- [ ] **Step 2: Run focused test and verify RED**

Run: `node --test test/online-controller.test.js`

Expected: FAIL because AFK reasons still use normal win/loss sound selection.

- [ ] **Step 3: Copy, verify, then remove the source file**

Use PowerShell with literal paths:

```powershell
$source = 'C:\Users\super\Downloads\wet-fart-meme.mp3'
$destination = 'C:\Users\super\Desktop\game\public\assets\sounds\wet-fart-meme.mp3'
Copy-Item -LiteralPath $source -Destination $destination
if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) { throw 'AFK sound copy verification failed' }
Remove-Item -LiteralPath $source
```

This is an explicitly requested move. Do not delete the source before matching hashes.

- [ ] **Step 4: Register and select AFK sound**

Add `afk` to `FILES`. In `_announceOnlineResult`, test membership in the fixed AFK reason set and call `sounds.play('afk')`; leave all other branches unchanged.

- [ ] **Step 5: Verify sound and build GREEN**

Run: `node --test test/online-controller.test.js && npm run build`

Expected: test PASS, build PASS, and `dist/assets/sounds/wet-fart-meme.mp3` exists with the destination hash.

- [ ] **Step 6: Commit asset checkpoint**

```powershell
git add -- public/assets/sounds/wet-fart-meme.mp3 src/sounds.js src/controller.js test/online-controller.test.js
git commit -m "feat: add afk loss feedback"
```

---

### Task 6: End-to-end proof, documentation, commit, and push

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-14-online-afk-adjudication.md` only to check completed boxes if useful; do not rewrite requirements.

**Interfaces:**
- Documents exact opening table, Unlimited three-strike behavior, final-room removal, and the fact that tab detection is enforced through authenticated signals plus missing-heartbeat fallback rather than perfect browser surveillance.

- [ ] **Step 1: Run complete automated verification**

Run separately and retain exit codes:

```powershell
npm test
npm run build
npx wrangler deploy --dry-run
git diff --check
```

Expected: all tests PASS, build PASS, dry-run PASS, and diff check has no errors. The known upstream `chess.js` sourcemap notice and pre-existing unresolved park background warning must be reported separately if still present.

- [ ] **Step 2: Run independent-context browser proof**

Start Wrangler and Vite. In two player tabs and one spectator tab:

1. Verify White opening countdown and an opening timeout popup/sound.
2. In another Unlimited room, complete two plies.
3. Hide/restore the current player's tab twice and verify strike 1 then 2 without ending the game.
4. Trigger a third away episode and verify immediate canonical loss on all three clients.
5. Verify a four-minute inactivity transition with controlled Worker time/integration proof and rendered countdown.
6. Refresh/reconnect and verify final state cannot revive.
7. Open Lobby, refresh, and verify the finished card is absent and another card reflows.
8. Check desktop and 360px mobile overflow plus console errors.

- [ ] **Step 3: Update README truthfully**

Document behavior and limitations. State that Page Visibility is a browser signal, while missing heartbeat covers closed/background-suspended clients; do not claim detection of operating-system focus or malicious clients beyond authenticated server enforcement.

- [ ] **Step 4: Commit documentation and final fixes**

```powershell
git add -- README.md docs/superpowers/plans/2026-08-14-online-afk-adjudication.md
git commit -m "docs: explain online afk rules"
```

- [ ] **Step 5: Push and verify remote identity**

```powershell
git push origin main
git rev-parse HEAD
git ls-remote origin refs/heads/main
git status --short --branch
```

Expected: local HEAD equals remote `refs/heads/main`; only the three preserved user-owned untracked paths remain.

