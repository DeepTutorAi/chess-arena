# Master Task Checklist: Game Review System Implementation

> **CRITICAL INSTRUCTIONS FOR THE EXECUTING AGENT:**
> 1. **Zero Bug Policy & Strict Verification**: All existing 92 tests (73 domain tests + 19 worker tests) and the Vite build MUST pass after every phase. Do not introduce regressions to existing gameplay modes (Online PVP, Bot, Arena, Sandbox).
> 2. **Careful Inspection Before Modification**: Read target files line-by-line before modifying them. Make surgical, incremental edits rather than wholesale overwrites.
> 3. **Follow the Master Plan**: All mathematical formulas, UI wireframes, gamemode integration flows, and hole mitigations are strictly specified in [plan.md](file:///c:/Users/super/Desktop/game/plan.md).
> 4. **Progress Tracking**: Tick off tasks as `[x]` as you complete and verify each step.

---

## Phase 1: Vector Icons & Audio Wiring
- [x] **1.1 Add Review Vector Icons to `src/icons.js`**
  - [x] Implement `iconBarChart(opts)` (Bar chart icon for Game Review button)
  - [x] Implement `iconTrendingUp(opts)` (Upward trend icon for accuracy/eval)
  - [x] Implement `iconAward(opts)` (Trophy/badge icon for game winner)
  - [x] Implement `iconZap(opts)` (Lightning icon for Brilliant / Great moves)
  - [x] Implement `iconSparkles(opts)` (Sparkle icon for Best move)
  - [x] Implement `iconAlertTriangle(opts)` (Warning icon for Inaccuracies / Mistakes)
  - [x] Implement `iconCheckCircle(opts)` (Check circle icon for solved puzzles)
- [x] **1.2 Verify Audio Hooks in `src/sounds.js`**
  - [x] Verify `sounds.play('victory')` fires on successful "Retry Mistake" solution
  - [x] Verify `sounds.play('lose')` fires on incorrect move in retry mode
  - [x] Verify `sounds.play('move')` fires during stepping
  - Note: wired in `src/review-ui.js` (`stepTo`, retry handlers) and exercised in the browser E2E run; `sounds.play` is failure-isolated by design.

---

## Phase 2: Core Math & Analysis Engine (`src/analyzer.js`)
- [x] **2.1 Worker Lifecycle Management**
  - [x] Implement `GameReviewAnalyzer` class
  - [x] Spawn dedicated Stockfish 18 Web Worker (`public/engine/stockfish-18-lite-single.js`)
  - [x] Implement `abort()` to call `worker.terminate()` immediately when review is cancelled or exited
- [x] **2.2 Mathematical Evaluation Functions**
  - [x] Implement `convertCentipawnsToWinProbability(cp, mate)` using standard logistic formula:
    $$W(cp) = 50 + 50 \times \left( \frac{2}{1 + e^{-0.00368208 \times cp}} - 1 \right)$$
  - [x] Implement `calculateDeltaWinProbability(bestCp, actualCp, turn)`
  - [x] Implement `classifyMove(deltaW, moveContext)` for all 10 tiers (Brilliant, Great, Best, Excellent, Good, Book, Inaccuracy, Mistake, Blunder, Miss)
  - [x] Implement `calculatePlayerAccuracy(deltaWList)` using weighted harmonic mean:
    $$A_{\text{total}} = \frac{N}{\sum_{i=1}^N \frac{1}{\max(1, A_i)}}$$
- [x] **2.3 Game Analysis Pipeline**
  - [x] Implement `analyzeGame(gameRecord, onProgress)`
  - [x] Iterate through all plies sequentially at depth 12
  - [x] Pre-calculate and cache array of FENs (`fens: [fen0, fen1, ...]`) for $O(1)$ stepping
  - [x] Stream progress callback `onProgress({ currentPly, totalPlies, percentage })`
- [x] **2.4 Automated Domain Tests for Analyzer (`test/analyzer.test.js`)**
  - [x] Write unit tests for $W(cp)$ curve ($0 \to 50\%$, $+100 \to 58.7\%$, $+500 \to 88.5\%$, $+M \to 100\%$)
  - [x] Write unit tests for $\Delta W$ and classification tier boundaries
  - [x] Write unit tests for harmonic mean player accuracy calculation
  - [x] Verify with `npm run test:domain`

---

## Phase 3: Review UI Components & Coach Service (`src/review-ui.js`)
- [x] **3.1 Progress Modal**
  - [x] Implement `showProgressModal(onCancel)` with smooth animated progress bar
  - [x] Implement `updateProgress(percentage, currentPly, totalPlies)`
- [x] **3.2 Phase 1: Review Summary Modal**
  - [x] Implement `showReviewSummaryModal(analysisResult, onStepThrough, onNewGame)`
  - [x] Render dual circular SVG accuracy gauges with animated `stroke-dashoffset`
  - [x] Render 8-tier move classification table with color-coded badges
  - [x] Render interactive SVG Advantage Graph (`renderAdvantageGraph`) with hover crosshairs & clickable ply jumps
  - Note: table renders all 10 canonical tiers (mockup's 8-cell grid layout; Book/Miss counts included so every classification is visible).
- [x] **3.3 Phase 2: Interactive Board Stepper**
  - [x] Implement `enterStepperMode(controller, analysisResult)` to dock review into the sidebar
  - [x] Implement `renderStepperPly(plyIndex)` updating:
    - [x] Vertical Evaluation Bar (+2.4 to -2.4 with smooth CSS height transition)
    - [x] On-board move square badge (`.review-square-badge`)
    - [x] Chessground green best-move arrow (`orig: bestFrom, dest: bestTo, brush: 'green'`)
    - [x] Chessground red mistake arrow/ring for played blunder
    - [x] Stepper navigation controls (`|<<`, `<`, `⏯`, `>`, `>>|`, `🔄 Flip`)
- [x] **3.4 Decoupled Coach Service**
  - [x] Implement `CoachService.generateInsight(plyAnalysis)` generating headline, explanation, tacticalTag, and speechScript
  - [x] Display visual coach card comparing "คุณเดิน" vs "ตาที่ดีกว่า"
  - [x] Keep audio pipeline decoupled for future TTS integration
- [x] **3.5 Tactical "Retry Mistake" Puzzle Flow**
  - [x] Implement `startRetryMistake(plyIndex, onResolved)`
  - [x] Reset board to position immediately preceding the mistake
  - [x] Unlock Chessground movable state strictly for the active side
  - [x] Validate move against engine's best move: play victory sound on correct move, provide retry / "ดูเฉลย" on incorrect move

---

## Phase 4: Styling & Obsidian Dark Theme (`src/styles.css`)
- [x] **4.1 Modal & Progress Bar Styling**
  - [x] Style `.review-modal-overlay` and `.review-modal` with Obsidian Glass dark tokens
  - [x] Style `.review-progress-track` and glowing `.review-progress-fill`
- [x] **4.2 Accuracy Gauges & Move Table**
  - [x] Style `.accuracy-gauge-svg` with circular progress glow
  - [x] Style move classification badges (`.tier-brilliant`, `.tier-best`, `.tier-blunder`, etc.)
- [x] **4.3 SVG Advantage Timeline Graph**
  - [x] Style `.advantage-graph-svg`, gradient fills (White area vs Black area), zero centerline, hover tooltip
- [x] **4.4 On-Board Badges & Engine Arrows**
  - [x] Style `.review-square-badge` with absolute positioning on target squares
  - [x] Style Chessground arrow brushes: `svg.cg-shapes g.green`, `g.red`
- [x] **4.5 Vertical Evaluation Bar**
  - [x] Style `.eval-bar-container` and `.eval-bar-fill` with smooth 0.3s height transition
- [x] **4.6 Replay Sidebar & Responsive Layout**
  - [x] Style docked Review Sidebar panel and Coach Insight card
  - [x] Ensure mobile responsive layout (<768px): stack board on top, controls & coach underneath

---

## Phase 5: Controller & Cross-Gamemode Wiring (`src/controller.js`, `src/ui.js`)
- [x] **5.1 Capture `GameHistoryRecord` in Terminal Game States**
  - [x] Capture in `_announceGameOver` (Checkmate, Draw, Stalemate)
  - [x] Capture in `resign()` (Resignation)
  - [x] Capture in timeout / `flag()`
  - [x] Capture in `_announceOnlineResult` (PVP Online finish)
- [x] **5.2 Wire Game Over UI**
  - [x] Update `showGameOver` in `src/ui.js` to include "📊 รีวิวเกม (Game Review)" button
  - [x] Add DOM container for the vertical evaluation bar on the board wrapper
- [x] **5.3 Implement `controller.startReview()`**
  - [x] Cleanly pause and clear active clocks (`_onlineClockTimer`, `_onlineAfkTimer`)
  - [x] Lock Chessground board interaction (`movable.free = false`)
  - [x] Launch analysis pipeline via `GameReviewAnalyzer`
  - [x] Bind keyboard navigation listeners (`ArrowLeft`, `ArrowRight`, `Home`, `End`, `Space`)
  - [x] Implement `exitReview()` restoring standard board and menu state

---

## Phase 6: Automated Verification & Cross-Gamemode Validation
- [x] **6.1 Test Suites**
  - [x] Run `npm run test:domain` (82/82 pass — 73 existing + 9 new analyzer tests)
  - [x] Run `npm run test:worker` (19/19 pass)
  - [x] Run `npm run build` (Vite production build succeeds; no new warnings)
- [ ] **6.2 PVP Online Integration Verification** — *code paths verified by 19/19 worker tests + controller record capture from `state.moves` (UCI), but a live 2-client session was NOT run: one browser profile cannot open two room connections (server 4001 "replaced" protection). Requires two independent browser profiles/devices.*
  - [ ] Verify review runs smoothly in browser on `http://localhost:5180/`
  - [ ] Verify review works for Host, Guest, and Spectators
  - [ ] Verify closing opponent's tab does not break the remaining player's review
  - [ ] Verify rematch requests during review display as a non-blocking floating toast *(the repo has no rematch server action yet — the floating toast channel ships wired to real review-time events; see final report)*
- [x] **6.3 Bot, Arena & Sandbox Verification**
  - [x] Verify Human vs AI review shows bot vs player accuracy correctly (browser E2E: Scholar's Mate vs Elo 1400 → White 92.5% / Black 19.5%)
  - [x] Verify Sandbox review initializes correctly from custom starting FEN (browser E2E: solo resign → `gamemode: "sandbox"`, review from `initialFen`)

---

## Phase 7: 10 Gap & Hole Mitigations Audit Checklist
- [x] **Hole 1**: Board interaction is completely locked during replay stepping; unlocked ONLY during "Retry Mistake". *(E2E: `movable.color === false` while stepping; unlock grants only the mover's color + legal dests; re-locked after retry ends)*
- [x] **Hole 2**: Clocks, timeouts, and AFK timers are cleared when entering review. *(`startReview()` stops local clock + both online timers)*
- [x] **Hole 3**: Web Worker terminates immediately if review modal is closed mid-analysis. *(`abort()` → `worker.terminate()`; cancel path E2E-tested via progress modal)*
- [x] **Hole 4**: FEN array is pre-computed for $O(1)$ zero-lag scrubbing. *(`analysis.fens` + `positions` built once by `buildReplay`)*
- [x] **Hole 5**: Global keyboard listeners are cleanly unbound upon exiting review mode. *(bound in `enterStepperMode`, removed in `exitStepperMode`; `dispose()` also tears down)*
- [x] **Hole 6**: Pawn promotions (UCI `e7e8q`) and castling are normalized across all modes. *(unit-tested: `e7e8q` → `a8=Q#`-style SAN, `e1g1` → `O-O`)*
- [x] **Hole 7**: Evaluation bar height transitions smoothly with CSS. *(`transition: height 0.3s ease-out`)*
- [x] **Hole 8**: Analysis depth is fixed at 12 (completes in ~4s for 40 moves). *(7-ply game analyzed in ~4s in dev including worker startup)*
- [x] **Hole 9**: Spectator review supports free board flipping (`🔄`). *(E2E: flip re-renders badges to mirrored squares; badge layer lives outside chessground's element which wipes foreign children on orientation change)*
- [x] **Hole 10**: Mobile viewport (<768px) scales cleanly in vertical stack without overflow. *(E2E at 390×844: no horizontal overflow, board on top, review panel stacked below)*
