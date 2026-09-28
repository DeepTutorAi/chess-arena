# Architectural Specification & Implementation Plan: Game Review System

This document provides the exhaustive architectural blueprint, mathematical models, UI layout specifications, AI direction engine, cross-gamemode integration matrices, and edge-case hole mitigations for the **Game Review System** in Chess Arena.

---

## 1. Executive Summary & Core Objectives

The Game Review System provides automated, high-fidelity post-game analysis inspired by modern chess platforms (such as Chess.com and Lichess). It evaluates every ply played in a completed match, classifies move quality, computes overall player accuracy scores (0–100%), plots an interactive advantage timeline graph, displays engine directional arrows indicating optimal moves at tactical mistake points, and provides step-by-step interactive coaching with "Retry Mistake" tactical recovery.

### Primary Objectives
1. **Client-Side Engine Execution**: Leverage the existing Stockfish 18 WebAssembly worker (`public/engine/stockfish-18-lite-single.js`) inside the browser, incurring zero server compute costs and zero latency overhead on Cloudflare Workers.
2. **Universal Gamemode Compatibility**: Fully decouple the review engine from game transport, allowing seamless review across:
   - **PVP Online Matches** (Cloudflare Durable Objects rooms)
   - **Player vs AI** (Stockfish levels 1–11)
   - **AI vs AI Arena**
   - **Sandbox Custom Setup** matches
3. **Rigorous Mathematical Foundation**: Implement standard logistic win-probability conversion, exponential penalty decay, and harmonic-mean accuracy aggregation.
4. **Visual Directional Coaching & Badges**:
   - On-board badges identifying move quality for every ply.
   - Luminous engine directional arrows (`orig -> dest`) showing the correct path on inaccuracies, mistakes, blunders, and misses.
5. **Decoupled AI Coach Architecture**:
   - Structured coach commentary cards comparing actual moves with engine recommendations.
   - Architecture designed with clean hooks for future Text-to-Speech (TTS) integration without breaking changes.
6. **Two-Stage Hybrid UX**:
   - **Phase 1**: An Obsidian Glass Review Summary Dashboard (Dual circular accuracy gauges, 8-tier move classification table, and advantage timeline graph).
   - **Phase 2**: An Interactive Replay Board Stepper (Evaluation advantage bar, on-board move badges, engine best-move arrows, coach card, and "Retry Mistake" interactive puzzles).

---

## 2. Visual Reference & UI Wireframes

### 2.1 Visual Reference Artifact
The high-fidelity visual design for Phase 1 (Review Summary Modal) has been rendered and stored at:
[review_modal_mockup.jpg](file:///c:/Users/super/Desktop/game/public/assets/mockups/review_modal_mockup.jpg)

![Phase 1 Review Summary Modal Mockup](file:///c:/Users/super/Desktop/game/public/assets/mockups/review_modal_mockup.jpg)

---

### 2.2 Phase 2: Interactive Replay Board Mode Wireframe

When transitioning to Replay Mode, the application transforms the board interface into an interactive analysis workbench:

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ CHESS ARENA  [Mode: Review / Replay]                            [Flip Board] [Export PGN] [Exit Review / Home]    │
├─────────┬────────────────────────────────────────────────────────┬───────────────────────────────────────────────┤
│ EVAL    │                     CHESSBOARD                         │               REVIEW SIDEBAR                  │
│ BAR     │                                                        │                                               │
│ ┌─────┐ │   8 ┌───┬───┬───┬───┬───┬───┬───┬───┐                  │ ┌───────────────────────────────────────────┐ │
│ │+2.4 │ │     │ r │   │ b │ q │ k │ b │   │ r │                  │ │ 📊 Game Overview                          │ │
│ │     │ │   7 ├───┼───┼───┼───┼───┼───┼───┼───┤                  │ │ White: Player 1 (88.4%)                   │ │
│ │     │ │     │ p │ p │ p │   │   │ p │ p │ p │                  │ │ Black: Player 2 (64.2%)                   │ │
│ │     │ │   6 ├───┼───┼───┼───┼───┼───┼───┼───┤                  │ └───────────────────────────────────────────┘ │
│ │     │ │     │   │   │ n │   │   │ n │   │   │                  │                                               │
│ │     │ │   5 ├───┼───┼───┼───┼───┼───┼───┼───┤                  │ ┌───────────────────────────────────────────┐ │
│ │White│ │     │   │   │   │ p │   │   │   │   │                  │ │ 🧭 Move List (Clickable Plies)            │ │
│ │Adv. │ │   4 ├───┼───┼───┼───┼───┼───┼───┼───┤                  │ │  1. e4 (Book)          e5 (Book)          │ │
│ │ 62% │ │     │   │   │   │ P │   │   │   │   │                  │ │  2. Nf3 (Best ★)       Nc6 (Best ★)       │ │
│ ├─────┤ │   3 ├───┼───┼───┼───┼───┼───┼───┼───┤                  │ │  3. Bc4 (Good 🟢)      Nf6 (Best ★)       │ │
│ │     │ │     │   │   │ N │   │   │ N │   │   │                  │ │  4. Ng5 (Excellent 🔵) d5 (Best ★)        │ │
│ │     │ │   2 ├───┼───┼───┼───┼───┼───┼───┼───┤                  │ │  5. exd5 (Best ★)      Na5?? [BLUNDER]    │ │
│ │Black│ │     │ P │ P │ P │   │ P │ P │ P │ P │                  │ └───────────────────────────────────────────┘ │
│ │     │ │   1 ├───┼───┼───┼───┼───┼───┼───┼───┤                  │                                               │
│ │-2.4 │ │     │ R │   │ B │ Q │ K │   │   │ R │                  │ ┌───────────────────────────────────────────┐ │
│ └─────┘ │       a   b   c   d   e   f   g   h                    │ │ 🧑‍🏫 Coach Tactical Insight                 │ │
│         │                                                        │ │ Tier: ❌ Blunder (ตาเดินผิดพลาดร้ายแรง)   │ │
│         │   [Badge]: Crimson [??] on Na5                         │ │ Loss: -4.85 Win Probability (-320 cp)     │ │
│         │   [Arrow]: Luminous Green Arrow from f6 to d5 (Nxd5)   │ │                                           │ │
│         │   [Threat]: Dashed Red Arrow from c4 to b5+ (Bb5+)     │ │ คุณเดิน: 5... Na5?                        │ │
│         │                                                        │ │ ตาที่ดีกว่า: 5... Nxd5! (ตามลูกศรเขียว)     │ │
│         │                                                        │ │ คำอธิบาย: การเดิน Na5 เปิดโอกาสให้ขาวรุก    │ │
│         │                                                        │ │ ด้วย Bb5+ และชิงความได้เปรียบทางตำแหน่ง   │ │
│         │                                                        │ │                                           │ │
│         │                                                        │ │ [💡 ลองเดินแก้ตัว (Retry Mistake)]        │ │
│         │                                                        │ └───────────────────────────────────────────┘ │
├─────────┴────────────────────────────────────────────────────────┴───────────────────────────────────────────────┤
│ STEPPER CONTROLS:  [ |<< First ]  [ < Prev ]  [ ⏯ Autoplay ]  [ > Next ]  [ >>| Last ]   [ 🔄 Flip Board ]       │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Mathematical Models & Classification Algorithms

Raw centipawn evaluations from chess engines cannot directly translate into human accuracy scores because a 100-centipawn loss in an even position (0.00 to -1.00) is decisive, whereas a 100-centipawn loss in a completely winning position (+8.00 to +7.00) has negligible impact on the outcome.

### 3.1 Centipawn to Win Probability Conversion
For any position evaluation $cp$ (in centipawns) from the perspective of the player to move, win probability $W \in [0, 100]$ is computed using the standard logistic sigmoid model:

$$W(cp) = 50 + 50 \times \left( \frac{2}{1 + e^{-0.00368208 \times cp}} - 1 \right)$$

For forced mate positions announced by the engine (e.g., Mate in $N$ moves):
- $\text{Mate in } +N \implies W = 100\%$
- $\text{Mate in } -N \implies W = 0\%$

### 3.2 Win Percentage Loss per Ply ($\Delta W$)
For each ply $i$:
1. Let $W_{\text{best}}(i)$ be the win probability of the engine's optimal move at position $i$.
2. Let $W_{\text{actual}}(i)$ be the win probability of the move actually chosen by the player.
3. The loss in win probability is:
   $$\Delta W_i = \max(0, W_{\text{best}}(i) - W_{\text{actual}}(i))$$

### 3.3 Move Classification Thresholds & Badges
Based on $\Delta W_i$ and tactical context, every move is categorized into one of the canonical tiers:

| Tier | Symbol | Badge Color | Condition / Criteria |
| :--- | :---: | :---: | :--- |
| **Brilliant** | `!!` | Cyan / Turquoise (`#26c2a3`) | Sound piece/exchange sacrifice where position remains winning ($W \ge 60\%$) and move is among engine top-1 recommendations. |
| **Great** | `!` | Royal Blue (`#3b82f6`) | The sole saving or winning move ($\Delta W_i = 0$ while all alternate legal moves have $\Delta W \ge 15\%$), or a game turning-point move. |
| **Best** | `★` | Emerald Green (`#22c55e`) | The engine's highest-evaluated move ($\Delta W_i = 0$). |
| **Excellent** | `✓` | Teal Green (`#10b981`) | Minor deviation with negligible loss ($0 < \Delta W_i \le 2\%$). |
| **Good** | `·` | Muted Green (`#84cc16`) | Solid move with minimal impact ($2\% < \Delta W_i \le 5\%$). |
| **Book** | `📖` | Warm Ochre (`#d97706`) | Move recognized in standard opening theory encyclopedia (plies 1–10). |
| **Inaccuracy** | `?!` | Amber / Yellow (`#eab308`) | Small positional concession ($5\% < \Delta W_i \le 10\%$). |
| **Mistake** | `?` | Orange (`#f97316`) | Clear tactical or strategic error ($10\% < \Delta W_i \le 20\%$). |
| **Blunder** | `??` | Crimson Red (`#ef4444`) | Severe blunder that throws away significant advantage or loses the game ($\Delta W_i > 20\%$). |
| **Miss** | `✗` | Vivid Purple (`#a855f7`) | Overlooked an opponent's blunder or missed a direct winning tactical fork/mate. |

### 3.4 Game Accuracy Score Calculation
For each player, the per-move accuracy $A_i$ is computed using an exponential decay curve:
$$A_i = 103.1668 \times e^{-0.04354 \times \Delta W_i} - 3.1669$$
Clamped strictly to $[0, 100]$.

The overall player accuracy score $A_{\text{total}}$ is aggregated across all plies of that player using a **weighted harmonic mean**:
$$A_{\text{total}} = \frac{N}{\sum_{i=1}^N \frac{1}{\max(1, A_i)}}$$
The harmonic mean ensures that one or two massive blunders appropriately drag down the total score, mirroring real competitive performance evaluation.

---

## 4. AI Directional Arrow & Tactical Coaching Engine

### 4.1 On-Board Visual Indicators
When stepping through moves during Replay Mode:
1. **Target Square Badge (`.review-square-badge`)**:
   - A circular icon badge rendered on the destination square of the move made.
   - Contains the tier symbol (`??`, `?`, `?!`, `★`, `!!`) with the corresponding tier color and a subtle pulse animation for blunders.
2. **AI Directional Best Move Arrow (`brush: 'green'`)**:
   - Rendered using Chessground's SVG shapes system (`ground.setAutoShapes()`).
   - Drawn from the origin square to the destination square of the engine's optimal move (`orig: bestFrom, dest: bestTo`).
   - Luminous neon green stroke with a sharp arrowhead, showing the exact direction the piece should have moved.
3. **Blunder Trail Arrow (`brush: 'red'`)**:
   - On moves classified as Mistake or Blunder, a semi-transparent red arrow shows what the player actually moved (`orig: actualFrom, dest: actualTo`), providing an instant visual contrast between the mistake and the solution.
4. **Refutation / Opponent Threat Arrow (`brush: 'yellow'`)**:
   - A secondary dashed amber arrow indicating the opponent's immediate punishing reply if the position allows a decisive refutation.

---

### 4.2 Decoupled AI Coach Architecture (Future TTS Ready)

To fulfill the requirement for interactive coaching without text/voice speech now while ensuring zero architectural rewrites when TTS is introduced, the coaching engine is designed as a standalone decoupled service:

```typescript
interface CoachTacticalInsight {
  plyIndex: number;
  tier: 'brilliant' | 'great' | 'best' | 'excellent' | 'good' | 'book' | 'inaccuracy' | 'mistake' | 'blunder' | 'miss';
  actualMove: { san: string; from: string; to: string };
  bestMove: { san: string; from: string; to: string };
  winProbLoss: number;          // e.g. 24.5%
  centipawnLoss: number;        // e.g. -310 cp
  headline: string;             // e.g. "ตาเดินผิดพลาดร้ายแรง (Blunder)"
  explanation: string;          // e.g. "การเดิน Na5 ทำให้เสียความคุ้มครองที่ d5 เปิดโอกาสให้ขาวรุกฆาตหรือชิงม้าฟรี"
  tacticalTag: string;          // e.g. "Hanging Piece", "Fork", "Pin", "Missed Mate"
  speechScript: string;         // Plain natural text reserved for future TTS audio synthesis
}
```

#### Audio & Speech Extensibility Contract:
```javascript
class CoachService {
  constructor(ttsProvider = null) {
    this.ttsProvider = ttsProvider; // Currently null; will accept TTS provider later
  }

  generateInsight(plyAnalysis) {
    // Generates headline, explanation, tacticalTag, and speechScript
  }

  speak(insight) {
    if (!this.ttsProvider) return; // Silent mode: no voice output until TTS provider is registered
    this.ttsProvider.synthesizeAndPlay(insight.speechScript);
  }
}
```
*Benefit: The visual card displays rich textual and tactical explanations immediately, while the audio pipeline is fully prepared for zero-friction TTS activation in the future.*

---

## 5. Universal Gamemode Integration Architecture

The review subsystem is completely decoupled from matchmaking and game transmission. It consumes a normalized input data structure: `GameHistoryRecord`.

### 5.1 Standard Input Interface (`GameHistoryRecord`)
```typescript
interface GameHistoryRecord {
  initialFen: string;           // Standard start or custom sandbox FEN
  moves: Array<{
    san: string;                // e.g. "e4", "Nf3", "O-O"
    from: string;               // e.g. "e2"
    to: string;                 // e.g. "e4"
    promotion?: string;         // "q", "r", "b", "n"
    timeSpentMs?: number;       // Clock time spent on move
  }>;
  result: '1-0' | '0-1' | '1/2-1/2' | '*';
  reason: string;               // checkmate, resignation, timeout, afk, etc.
  players: {
    white: { name: string; avatar?: string; elo?: number | string };
    black: { name: string; avatar?: string; elo?: number | string };
  };
  gamemode: 'online' | 'hva' | 'aiva' | 'sandbox';
}
```

---

### 5.2 PVP Online (Multiplayer) Detailed Integration

#### A. Cloudflare Durable Object Room Lifecycle
1. The Cloudflare Durable Object (`ChessRoom` in `worker/room.js`) holds the authoritative game state and move history as an array of UCI strings (`room.moves: ["e2e4", "e7e5", ...]`).
2. When the game ends by checkmate, resignation, timeout, opening AFK, or unlimited AFK strikes:
   - Server assigns `room.status = 'finished'`, `room.result`, and `room.reason`.
   - Server broadcasts the terminal `state` message to all connected clients (Host, Guest, Spectators).
3. The client receives this message in `controller._onOnlineState(state)`.
4. Client reconstructs the full verbose history via `new Chess(state.initialFen)` and saves a local `_lastGameRecord`.

#### B. Independent Client-Side Review & Offline Resilience
- **Zero Server Compute**: Stockfish WASM executes entirely in each client's browser Web Worker.
- **Opponent Disconnect Immunity**: If the opponent rage-quits, closes the tab, or disconnects immediately after checkmate, the remaining player and spectators can review the game without disruption because the entire move history is cached locally.
- **Spectator Experience**: Spectators can click "รีวิวเกม" and review the match identically to players.

#### C. Rematch Synchronization (Non-Blocking Floating Toast)
- If one player requests a rematch while the other is reviewing:
  - Rather than opening a modal that covers the review interface, a floating toast appears in the top corner:
    *"คู่แข่งต้องการเริ่มเกมใหม่! [เริ่มเกมใหม่] [ดูรีวิวต่อ]"*.
  - If accepted: The review worker is cleanly aborted, review mode exits, and the new match starts.
  - If dismissed or ignored: The player continues reviewing at their own pace without interruption.

---

### 5.3 Player vs AI (`hva` - Human vs AI) Integration
- Captures verbose move history from `this.game.history({ verbose: true })`.
- Orientation defaults to the human player's color (`this.humanSide`).
- Tactical highlights specifically compare human player moves against Stockfish calculations, showing where tactical advantages were surrendered.

---

### 5.4 AI vs AI Arena (`aiva`) Integration
- Captures move history from competing local engine instances.
- Allows comparing evaluation curves between two AI engine tiers.

---

### 5.5 Sandbox Mode (`solo`) Integration
- Supports custom board positions set up via the board editor (`this.sandboxInitialFen`).
- The analyzer passes `position fen <initialFen> moves ...` to Stockfish so tactical evaluations are computed accurately from the custom setup rather than assuming standard chess opening setup.

---

## 6. Gap & Hole Analysis (อุดช่องโหว่ทาง UX และ Code ทั้งหมด)

To prevent bugs, performance degradations, or confusing UX states, the following 10 potential edge cases and architectural holes are explicitly resolved:

| # | Potential Hole / Edge Case | Risk Level | Architectural Resolution & Safeguard |
|---|---|---|---|
| **1** | **Board Dragging during Replay** | **HIGH** | In Replay Mode, Chessground must lock `movable: { free: false, color: undefined }`. Dragging is completely disabled during stepping. Interaction is unlocked ONLY when entering "Retry Mistake" mode, locked strictly to the pre-mistake position and legal moves of that turn. |
| **2** | **Active Clocks & AFK Timers Running** | **HIGH** | Entering Review Mode calls `clearInterval(this._onlineClockTimer)`, `clearInterval(this._onlineAfkTimer)`, and resets clock UI so timers do not tick or trigger false timeouts in the background. |
| **3** | **Worker Cancellation & Memory Leaks** | **HIGH** | If the user closes the modal, starts a new game, or navigates home while analysis is running (e.g. at 30%), `analyzer.abort()` is called immediately to terminate the Web Worker (`worker.terminate()`), preventing CPU waste. |
| **4** | **Replay Latency during Rapid Scrubbing** | **MEDIUM** | Rather than recalculating board positions from move 0 on every step, `GameReviewAnalyzer` pre-computes an array of FENs: `fens: [fen0, fen1, fen2, ...]`. Stepping or dragging the scrubber is an $O(1)$ memory lookup with zero lag. |
| **5** | **Keyboard Navigation Conflict** | **MEDIUM** | Bind keyboard listeners (`ArrowLeft` = Prev, `ArrowRight` = Next, `Home` = Start, `End` = End, `Space` = Autoplay) ONLY while Review Mode is active. Cleanly unbind them on exit to avoid accidental inputs during gameplay. |
| **6** | **Pawn Promotions & Castling UCI Parsing** | **MEDIUM** | Online games transmit UCI strings (`e7e8q`, `e1g1`). SAN generation must correctly preserve promotion flags ('q', 'r', 'b', 'n') and castling legality across both UCI and SAN paths. |
| **7** | **Evaluation Bar Smooth Transition** | **LOW** | CSS `transition: height 0.3s ease-out` on the evaluation fill bar prevents jarring jumps when stepping between moves. |
| **8** | **Analysis Depth vs Execution Time** | **MEDIUM** | Depth is fixed at 12 plies. At ~50ms per position on Stockfish WASM, a 40-move game (80 plies) completes in ~4 seconds, accompanied by a live percentage progress bar. |
| **9** | **Spectator Board Orientation** | **LOW** | Spectators default to White orientation, but a prominent "🔄 สลับฝั่งกระดาน (Flip Board)" button allows viewing from Black's perspective at any time. |
| **10** | **Mobile & Responsive Layouts (<768px)** | **MEDIUM** | On screens narrower than 768px, the layout switches from side-by-side to a vertical stack: Evaluation bar sits horizontally above the board or slim on the left, with the Stepper toolbar and Coach card positioned directly underneath. |

---

## 7. Subsystem Components & Workflows

### 7.1 Component Diagram
```
                     ┌────────────────────────────────┐
                     │   Completed Game Controller    │
                     │  (Online / Bot / Arena / Solo) │
                     └───────────────┬────────────────┘
                                     │ triggers review with GameHistoryRecord
                                     ▼
                     ┌────────────────────────────────┐
                     │        ReviewAnalyzer          │
                     │       (src/analyzer.js)        │
                     └───────┬────────────────┬───────┘
                             │                │
            spawns/manages   │                │ streams progress & plies
                             ▼                ▼
        ┌────────────────────────┐   ┌────────────────────────┐
        │ Stockfish Web Worker   │   │     ReviewUI Controller│
        │ (Dedicated evaluation) │   │   (src/review-ui.js)   │
        └────────────────────────┘   └──────────┬─────────────┘
                                                │
                          ┌─────────────────────┴─────────────────────┐
                          ▼                                           ▼
              [Review Summary Modal]                      [Interactive Board Stepper]
            - Accuracy Rings (White/Black)              - Evaluation Advantage Bar
            - 8-Tier Move Table                         - Board Piece Move Badges
            - Interactive SVG Advantage Graph           - Chessground Best-Move Arrows
            - Transition to Board Stepper               - Tactical "Retry Mistake"
```

---

### 7.2 State Machine of Game Review
```
[GAME COMPLETED]
       │
       ▼
 [showGameOver] ──(Clicks "รีวิวเกม")──► [ANALYZING_STATE] (Worker running depth 12)
                                                │
                                    (User closes modal) ──► worker.terminate()
                                                │
                               Streams progress (0%..100%)
                                                │
                                                ▼
                                    [REVIEW_SUMMARY_MODAL]
                                                │
                       (Clicks "ดูตาเดินบนกระดาน")
                                                │
                                                ▼
                                      [BOARD_STEPPER_MODE]
                                        ▲            │
                         (Success /     │            │ (Clicks "ลองเดินแก้ตัว")
                          Exit)         │            ▼
                                  [RETRY_MISTAKE_ACTIVE] (Board unlocked for 1 move)
```

---

### 7.3 Phase 1: Review Summary Modal Workflow
1. When game ends, `showGameOver` renders with the primary action button: **"📊 รีวิวเกม (Game Review)"**.
2. User clicks the button; the game over modal closes and `ReviewAnalyzer` launches.
3. A modal with an animated progress bar displays: *"กำลังวิเคราะห์รูปเกม... 45% (ตาที่ 18/40)"*.
4. On analysis completion:
   - **Dual Circular Accuracy Gauges**: Animated SVG circular progress meters displaying White and Black accuracy (0–100%).
   - **8-Tier Move Breakdown Table**: Side-by-side counts for Brilliant, Great, Best, Excellent, Good, Book, Inaccuracy, Mistake, and Blunder.
   - **Interactive SVG Advantage Graph**:
     - Plots win probability from 0% (Black winning) to 50% (even) to 100% (White winning).
     - Hovering across the graph shows a cursor line and tooltip with the exact move and evaluation.
     - Clicking any point on the graph jumps directly to that ply.
   - **Primary Action**: Button "🔍 ดูตาเดินบนกระดาน (Step Through Moves)".

---

### 7.4 Phase 2: Interactive Board Stepper & "Retry Mistake" Workflow
1. Clicking "ดูตาเดินบนกระดาน" transitions the UI:
   - Summary modal closes.
   - Right sidebar transforms into the **Review Stepper Panel**.
   - Left edge of chessboard displays the vertical **Evaluation Bar**.
   - Board pieces are locked in non-draggable mode.
2. **On-Board Visuals**:
   - **Move Badge**: Target square of the move displays a badge icon (`??`, `?`, `*`, `!!`).
   - **Best Move Arrow**: Chessground draws a luminous green arrow (`#81b64c`) pointing from origin to destination of the engine's recommended best move.
   - **Blunder Indicator**: Red arrow or square ring highlighting the played mistake.
3. **Sidebar Controls**:
   - Stepper buttons: `|<<`, `<`, `⏯`, `>`, `>>|` and keyboard arrow key support (Left/Right).
   - Coach Tactical Card detailing move classification, score delta, and comparison between played move and optimal move.
4. **"Retry Mistake" Interactive Puzzle Mode**:
   - Available on moves classified as Inaccuracy, Mistake, or Blunder via button **"💡 ลองเดินแก้ตัว (Retry Mistake)"**.
   - When clicked:
     1. The board resets to the position immediately before the blunder.
     2. Chessground enables drag-and-drop strictly for the player whose turn it is.
     3. User makes a move on the board.
     4. If the move matches the engine's best move:
        - Board plays success sound.
        - Celebration banner displays: "ถูกต้อง! นี่คือตาที่ดีที่สุด".
        - Coach card reveals the refutation explanation.
     5. If the move is incorrect:
        - Displays: "ยังไม่ใช่ตาที่ดีที่สุด ลองใหม่อีกครั้ง".
        - Option to "ดูเฉลย (Show Solution)" which animates the best move automatically.

---

## 8. Implementation Steps & File Modifications

### Step 1: Core Mathematical & Worker Engine (`src/analyzer.js`) [NEW]
- Create `GameReviewAnalyzer` class.
- Manage lifecycle of a dedicated Web Worker instance loading `public/engine/stockfish-18-lite-single.js`.
- Provide methods:
  - `convertCentipawnsToWinProbability(cp, mate)`: Logistic conversion formula.
  - `calculateDeltaWinProbability(bestCp, actualCp, turn)`: Calculates $\Delta W$.
  - `classifyMove(deltaW, moveContext)`: Assigns one of the 10 tiers.
  - `calculatePlayerAccuracy(deltaWList)`: Harmonic mean accuracy formula.
  - `analyzeGame(gameRecord, onProgress)`: Async pipeline iterating through all plies, running `position fen ... moves ...` and `go depth 12`, parsing UCI `info depth ... score cp ... pv ...`, pre-computing FEN array, and returning complete analysis.
  - `abort()`: Cleanly terminates Web Worker on exit.

### Step 2: UI Components & Visualizations (`src/review-ui.js`) [NEW]
- Create `ReviewUI` manager:
  - `showProgressModal(onCancel)`
  - `updateProgress(percentage, currentPly, totalPlies)`
  - `showReviewSummaryModal(analysisResult, onStepThrough, onNewGame)`
  - `renderAdvantageGraph(history, onSelectPly)`: Responsive pure SVG area chart.
  - `enterStepperMode(controller, analysisResult)`: Dock review panel into sidebar.
  - `renderStepperPly(plyIndex)`: Update board shapes, green best-move arrows, square badges, eval bar, and coach comments.
  - `startRetryMistake(plyIndex, onResolved)`: Handle retry puzzle mode.
- Create `CoachService`:
  - Generates structured tactical card explanations (`headline`, `explanation`, `tacticalTag`, `speechScript`).
  - Silent/visual mode active currently; decoupled hook ready for future TTS integration.

### Step 3: Vector Icons & Audio Wiring (`src/icons.js`, `src/sounds.js`) [MODIFY]
- In `src/icons.js`:
  - Add vector SVG icons for review components: `iconBarChart`, `iconTrendingUp`, `iconAward`, `iconZap`, `iconSparkles`, `iconAlertTriangle`, `iconCheckCircle`.
- In `src/sounds.js`:
  - Wire existing sound effects for review feedback: `sounds.play('victory')` on successful "Retry Mistake" solve, `sounds.play('lose')` on incorrect attempt, and `sounds.play('move')` during stepping.

### Step 4: Controller Integration (`src/controller.js`) [MODIFY]
- Capture `this._lastGameRecord` whenever any game finishes in `_announceGameOver`, `resign`, `flag`, or `_announceOnlineResult`.
- Add `startReview()` method:
  - Validates `_lastGameRecord`.
  - Spawns `ReviewUI` and invokes `GameReviewAnalyzer.analyzeGame()`.
  - Manages board state during review navigation without mutating the active game session.
  - Clears clocks and AFK intervals upon entering review.
- Support non-blocking rematch toast notifications in online rooms.

### Step 5: Game Over Popup Wiring (`src/ui.js`) [MODIFY]
- Update `showGameOver(title, detail, onNewGame, onHome, onReview)`:
  - Add "📊 รีวิวเกม (Game Review)" button with `iconBarChart`.
  - Clicking calls `onReview()`.
- Add DOM structure for vertical evaluation bar beside the chessboard.

### Step 6: Design & Theming (`src/styles.css`) [MODIFY]
- Add Obsidian Glass styling for Review Summary Modal (`.review-modal-overlay`, `.review-modal`).
- Style dual accuracy circular gauges (`.accuracy-gauge-svg`, animated stroke-dashoffset).
- Style 8-tier move classification table with color-coded badges (`.tier-brilliant`, `.tier-best`, `.tier-blunder`, etc.).
- Style SVG timeline advantage graph with gradient fills and interactive hover indicator.
- Style on-board move badge overlays (`.review-square-badge`) and engine arrows (`svg.cg-shapes g.green`, `g.red`).
- Style vertical evaluation advantage bar (`.eval-bar-container`).
- Style docked Replay Stepper panel and "Retry Mistake" interactive card.

### Step 7: Automated Testing (`test/analyzer.test.js`) [NEW]
- Test centipawn to win probability conversion curve against known benchmarks (0 cp = 50%, +100 cp = 58.7%, +500 cp = 88.5%, mate = 100%).
- Test $\Delta W$ calculation and classification boundaries (Blunder > 20%, Mistake 10-20%, Inaccuracy 5-10%, Best 0%).
- Test player accuracy calculation with harmonic mean penalty behavior.
- Test move record normalization from both SAN and UCI formats.

---

## 9. Verification & Quality Assurance Plan

### 9.1 Automated Test Execution
```powershell
npm run test:domain     # Verify analyzer logic, math functions, and DOM unit tests
npm run test:worker     # Verify Cloudflare Worker & Durable Object online room tests
npm run build           # Verify Vite bundle compilation and zero tree-shaking regressions
```

### 9.2 Browser E2E Test Flow
1. **PVP Online Review Flow**:
   - Launch online room on port 5180.
   - Host and join via two browser contexts.
   - Play 4 plies: `1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#` (Scholar's Mate).
   - In Game Over modal, click "📊 รีวิวเกม".
   - Verify progress bar reaches 100%.
   - Verify Review Summary Modal opens: White accuracy ~90%+, Black accuracy showing blunder on `4... Nf6??`.
   - Verify Advantage Graph shows steep spike for White on move 4.
   - Click "ดูตาเดินบนกระดาน": Verify vertical evaluation bar, green best-move arrow (`Qe7`), and blunder badge on `Nf6`.
   - Click "ลองเดินแก้ตัว": Verify board resets to move 3, make `Qe7`, verify puzzle success confirmation.
2. **Opponent Disconnect Resilience**:
   - Host closes tab while Guest reviews game: verify review continues smoothly without crashes.
3. **Bot & Sandbox Review Flow**:
   - Play vs Bot level 3, resign, verify review works identically.
   - Set up custom Sandbox position, play 2 moves, verify review initializes from custom FEN correctly.
