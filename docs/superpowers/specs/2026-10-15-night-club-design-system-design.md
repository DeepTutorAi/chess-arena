# Night Club Chess Design System (UI/UX Phase 2)

**Date:** 2026-10-15
**Status:** Approved design, awaiting spec review

## Outcome

Replace the four visual languages the app currently mixes (green park home, purple and gold lobby, brown game screen, teal review) with one design system, "Night Club Chess", applied to every screen. Phase 2 changes how the app looks, not what it does: every flow, control, and piece of copy keeps its current behaviour. The one intended behaviour change is that modals trap keyboard focus (an accessibility fix that comes with consolidating the modal implementations).

Layout restructuring (a new home layout, a waiting-room invite card, redesigned player bars) is phase 3 and out of scope here.

## Decisions already made

| Decision | Choice |
|---|---|
| Direction | A, "Night Club Chess": charcoal and blue-black surfaces, the existing brand green as accent, gold reserved for victory and rank |
| Board | New night board colours; the cburnett piece set is unchanged |
| Theme modes | Dark only; no light mode |
| Fonts | Self-hosted, no third-party font requests (offline PWA, no user data sent elsewhere) |
| Tooling | Plain CSS custom properties; no CSS framework; no build pipeline changes |
| Delivery | Tokens and components first, then migrate one screen per commit (approach 1) |

## Current state (measured 2026-10-15)

- `src/styles.css`: 2,804 lines, the only app stylesheet.
- 72 distinct hex colours and 129 distinct `rgba()` values against about 12 colour custom properties.
- 35 distinct `font-size` values (including 10px, 10.5px, 11px, 11.5px), weights up to 900.
- 30 distinct `border-radius` values and 32 distinct `box-shadow` values.
- Five separately built overlays: `.modal-overlay` (via `ui.openModal`), `.review-modal-overlay`, `.live-lobby-overlay`, `.join-lobby-overlay`, `.promo-overlay`.
- Roughly 20 one-off button styles (`lobby-create-btn`, `room-action`, `sandbox-*-btn`, `step-btn`, `review-exit-btn`, `park-quick-btn`, `action-btn`, and others) next to the generic `.btn`.
- One global `:focus-visible` rule; the PGN import field removes its outline.
- System font stack only, so Thai renders differently per operating system.
- The status bar under the board uses the same green `done` tone for wins and losses.

## Design

### 1. Colour tokens

All colours live in `src/tokens.css`. Contrast ratios are WCAG 2.x, measured against `surface-1`; every text and status token also reaches 4.5:1 on `bg`, `surface-2`, and `surface-3` (the lowest value is listed where it differs).

| Token | Value | Use | Contrast |
|---|---|---|---|
| `--bg` | `#0f1117` | Page canvas | — |
| `--surface-1` | `#161a22` | Panels, sidebars, player bars | — |
| `--surface-2` | `#1d222c` | Cards, inputs, modal body | — |
| `--surface-3` | `#262c38` | Hover, raised chips, avatars | — |
| `--border` | `#2e3542` | Default hairline | — |
| `--border-strong` | `#3d4656` | Emphasised edge, secondary button | — |
| `--text` | `#eef1f6` | Primary text | 15.4:1 |
| `--text-muted` | `#a3acbb` | Supporting text | 7.6:1 (6.1:1 on `surface-3`) |
| `--text-subtle` | `#8a93a3` | Metadata (ratings, times) | 5.6:1 (4.5:1 on `surface-3`) |
| `--accent` | `#81b64c` | Brand green, primary actions, "win" | 7.2:1 |
| `--accent-hover` | `#93c75a` | Primary hover | — |
| `--on-accent` | `#10200a` | Text on accent fills | 7.1:1 on accent |
| `--gold` | `#e7c26a` | Victory, rank, rating | 10.2:1 |
| `--on-gold` | `#1e1606` | Text on gold fills | 10.5:1 on gold |
| `--win` | `var(--accent)` | Outcome: win | 7.2:1 |
| `--loss` | `#f36e68` | Outcome: loss, danger actions, errors | 6.0:1 (4.8:1 on `surface-3`) |
| `--draw` | `var(--text-muted)` | Outcome: draw | 7.6:1 |
| `--warn` | `#f2b33d` | AFK countdown, warnings | 9.4:1 |
| `--info` | `#5aa9e6` | Engine thinking, informational | 6.9:1 |
| `--scrim` | `rgba(8, 10, 14, 0.72)` | Modal backdrop | — |
| `--glass` | `rgba(22, 26, 34, 0.72)` | Modal surface over imagery (with solid fallback) | — |

Chip tints are derived from these tokens (`color-mix(in srgb, var(--accent) 16%, transparent)` and so on), not new hex values.

**Night board** (`src/board-night.css`, replacing the import of `chessground.brown.css`):

| Token | Value | Notes |
|---|---|---|
| `--board-light` | `#cfd8dc` | Light squares |
| `--board-dark` | `#466f68` | Dark squares |
| `--board-coord-on-light` | `#2f4f49` | 6.2:1 on light squares |
| `--board-coord-on-dark` | `#f2f5f7` | 5.1:1 on dark squares |
| `--board-last-move` | `color-mix(in srgb, var(--gold) 45%, transparent)` | Last move highlight |
| `--board-selected` | `color-mix(in srgb, var(--accent) 55%, transparent)` | Selected square, move destinations |
| `--board-check` | `radial-gradient(ellipse at center, color-mix(in srgb, var(--loss) 85%, transparent) 0%, transparent 70%)` | King in check |

The board SVG background is generated in `board-night.css` (two-colour 8×8 pattern), the same way chessground's brown theme does it.

### 2. Typography, spacing, radius, elevation, motion

**Font.** IBM Plex Sans Thai via `@fontsource/ibm-plex-sans-thai@5.3.0` (OFL-1.1), weights 400, 500, 600, 700, subsets `thai` and `latin` only. Measured size: about 12 KB (Thai) plus 18 KB (Latin) per weight, about 120 KB total, loaded per `unicode-range`. Vite bundles the files with hashed names, which `public/sw.js` already treats as immutable (`HASHED_ASSET` matches `woff2`). Fallback stack: `'IBM Plex Sans Thai', 'Noto Sans Thai', system-ui, sans-serif`. `font-display: swap`.

Clocks and move numbers use `font-variant-numeric: tabular-nums`. Verification step: confirm the font honours `tnum` (digit widths equal in the browser). If it does not, add `@fontsource/jetbrains-mono` 600 (Latin subset only) for `.clock` and move numbers.

**Type scale** (replaces 35 sizes; nothing below 12px):

| Token | Size / weight / line-height | Use |
|---|---|---|
| `--fs-xs` | 12px / 500 / 1.4 | Captions, uppercase labels (letter-spacing .06em) |
| `--fs-sm` | 13px / 400 / 1.55 | Secondary UI text |
| `--fs-md` | 14px / 400 / 1.55 | Default UI text |
| `--fs-lg` | 16px / 500 / 1.5 | Emphasis, inputs on narrow screens |
| `--fs-xl` | 20px / 600 / 1.3 | Section and modal titles |
| `--fs-2xl` | 24px / 600 / 1.25 | Game-over title |
| `--fs-3xl` | 32px / 700 / 1.2 | Rating and stat numbers |
| `--fs-display` | `clamp(28px, 4vw, 44px)` / 700 / 1.15 | Home and lobby hero |

Weights are limited to 400, 500, 600, 700 (the font has no 800 or 900).

**Spacing** (4px grid): `--space-1` 4px, `--space-2` 8px, `--space-3` 12px, `--space-4` 16px, `--space-6` 24px, `--space-8` 32px, `--space-12` 48px.

**Radius**: `--radius-sm` 6px (chips, badges), `--radius-md` 10px (buttons, inputs), `--radius-lg` 14px (cards, panels, modals), `--radius-full` 999px (pills, avatars). The board keeps 4px.

**Elevation**:

- `--shadow-1`: `0 1px 2px rgba(0, 0, 0, 0.35)` (buttons, resting cards)
- `--shadow-2`: `0 8px 24px rgba(0, 0, 0, 0.45)` (panels, board, hovered cards, toasts)
- `--shadow-3`: `0 24px 64px rgba(0, 0, 0, 0.6)` (modals)
- `--ring-focus`: `0 0 0 2px var(--bg), 0 0 0 4px var(--accent)` (every focusable component)

**Motion**: `--dur-fast` 120ms (hover, press), `--dur-base` 200ms (panels; matches the board animation), `--dur-slow` 320ms (modals). `--ease-out: cubic-bezier(0.2, 0.8, 0.2, 1)`. Under `prefers-reduced-motion: reduce`, all transitions and animations are disabled globally.

**Layout heights become tokens.** `--bars-h` (114px) and `--board-chrome` (172px) drive the board size formula. They stay fixed values, and the player bar and status bar heights are pinned to them explicitly so the font change cannot alter the board size.

### 3. Shared components

All live in `src/components.css` and use tokens only.

| Component | Variants | Replaces |
|---|---|---|
| `.btn` | `primary`, default secondary, `ghost`, `danger`; sizes `sm` 32px, default 40px, `lg` 48px, `icon` | About 20 one-off button styles; their class names stay for layout only |
| Modal (`ui.openModal`) | `sm` 420px, `md` 560px, `lg` 720px; sticky header and action footer; bottom sheet under 600px; focus trap | `.modal-overlay`, `.review-modal-overlay`, `.promo-overlay` |
| `.screen` | Full-screen opaque page | `.live-lobby-overlay`, `.join-lobby-overlay` |
| `.card`, `.card--interactive` | Static; interactive adds hover, focus ring, `makeActivatable` keyboard support | Mode cards, room cards, history rows, home action cards |
| `.field` with `input`, `select`, `textarea`, `input[type=range]` | Label above, help text below; 40px controls; 16px text under 600px wide (prevents iOS zoom) | Name, avatar, Elo slider, PGN import |
| `.segmented` | Radio group styled as one control | Colour, time control, visibility, lobby tabs, moves/log tabs |
| `.chip` | Tones `accent`, `gold`, `info`, `neutral` | `tag-cyan/green/amber/purple`, room status badge, time and spectator labels |
| `.status-bar` | Neutral (no tone) plus tones `turn`, `thinking`, `win`, `loss`, `draw`, `warn`, `error` | Current `''`, `busy`, `done`, `err` classes |
| `.toast` | Tones `info`, `success`, `warn`, `danger` | `floating-toast`, AFK warning surface |

Rules:

- At most one `primary` button per view.
- `danger` buttons are outlined, never filled, and never receive initial focus (extends `ui.confirm()` from phase 1).
- Minimum hit target 40px; 44px under 600px wide.
- Game-specific composites (player bar, clock, action strip, move list, eval bar, coach card) are rebuilt from these primitives with their current structure; restructuring them is phase 3.

**Status tones.** `ui.setStatus(text, tone)` accepts the new tone names. The controller passes `win`, `loss`, or `draw` from `_viewerOutcome()` (phase 1) when a game ends, and no tone when the viewer did not play (AI vs AI, sandbox, spectating). It passes `thinking` where it passes `busy` today, `turn` on the player's move, `warn` for AFK and connection warnings, and `error` where it passes `err` today. The old `busy`, `done`, and `err` values are removed.

**Focus trap.** `ui.openModal` keeps focus inside the dialog: Tab from the last focusable element moves to the first, Shift+Tab from the first moves to the last. Escape still closes and restores focus to the opener (existing behaviour).

### 4. Migration order

One commit per row. The app stays shippable after every commit.

| # | Commit | Scope |
|---|---|---|
| 0 | Foundation | `tokens.css`, font import, `components.css`, `board-night.css`. Existing variables (`--bg`, `--panel`, `--panel-2`, `--line`, `--text`, `--muted`, `--accent`, `--accent-hover`, `--on-accent`, `--amber`, `--red`, `--lobby-green`, `--lobby-gold`) become aliases of the new tokens, so the new palette applies everywhere at once |
| 1 | Home and shell | Top bar, home hero, Quick Play button, mode picker modal |
| 2 | Game screen | Player bars, clocks, action strip, status bar tones, moves and log tabs, sandbox panels, promotion picker |
| 3 | Game-over and dialogs | Game-over card and pill, toasts, AFK warning, options, confirm dialogs |
| 4 | Lobby | Live lobby and private join moved to `.screen`, room cards, filters |
| 5 | Review | Summary modal, stepper panel, coach card, eval bar, advantage graph colours |
| 6 | Remaining screens | History, profile, PGN import, Quick Play view |
| 7 | Cleanup | Remove dead rules and the temporary aliases; switch guard tests to their final limits |

## Testing and verification

### New and changed tests

- **`test/design-tokens.test.js`** (new): every token in section 1 and 2 is defined in `tokens.css`; contrast is computed from the token values with a WCAG luminance helper and asserted at 4.5:1 or more for every text token on every surface, `on-accent` on `accent`, `on-gold` on `gold`, and both board coordinate pairs.
- **Ratchet guard** (in `test/layout-css.test.js`): counts raw hex and `rgba()` values outside `tokens.css` and `board-night.css` and asserts the count does not exceed a baseline. Each migration commit lowers the baseline; commit 7 sets it to 0. The same ratchet applies to `font-size` values that are not `var(--fs-*)`, and no `font-size` may be below 12px.
- **Focus trap** (in `test/ui-dialogs.test.js`): Tab from the last control returns to the first, Shift+Tab from the first goes to the last, Escape closes and restores focus.
- **Status tones** (in `test/online-controller.test.js`): ending a game as the loser sets tone `loss`, as the winner `win`, a draw `draw`; AI vs AI and sandbox use a neutral tone.

### Compatibility rule for existing tests

Class names that tests select on are kept; new classes are added next to them, never renamed. This covers at least `.btn.primary` (9 uses), `.review-summary-modal`, `.review-modal-overlay`, `.history-row`, `.import-status`, `.quick-status`, `.review-opening`, `.profile-trend`, and `[data-*]` hooks. All existing tests pass at every commit.

### Per-commit verification

1. `npm test` exits 0 (domain and worker suites) and `vite build` exits 0.
2. The migrated screens are checked in the built-in browser at 1280×800 and 375×812, compared with before-screenshots, with no console errors.
3. After commit 7: a full walkthrough of every flow, including a two-player online game against a local `wrangler dev` worker.

## Risks

| Risk | Mitigation |
|---|---|
| Board size is computed from fixed chrome heights; new Thai line heights could overflow the viewport | Pin player bar and status bar heights to `--bars-h` and `--board-chrome`; check the board at the 9 viewports the current layout was verified at |
| Board theme CSS order conflicts with chessground's brown theme | Stop importing `chessground.brown.css`; `board-night.css` is the only board colour source |
| Flash of unstyled text while fonts load | `font-display: swap` and a close fallback stack |
| `backdrop-filter` cost on older phones | Glass only on modals over imagery, with an opaque fallback via `@supports` |
| About 120 KB of added font data | `unicode-range` subsets; hashed files cached permanently by the service worker |
| `styles.css` is a high-churn file | Short-lived commits landed in order; no long-running branch |

## Out of scope

- Layout restructuring of home, game screen, waiting room, and lobby (phase 3).
- Light mode, user-selectable board themes, new artwork.
- Copy rewrites beyond what a component change requires.
- Any change to game rules, online protocol, storage, or engine behaviour.
