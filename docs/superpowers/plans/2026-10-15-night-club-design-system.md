# Night Club Chess Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the app's four visual languages with one token-driven "Night Club Chess" design system, migrating one screen per commit without changing app behaviour.

**Architecture:** Three new stylesheets load before `styles.css`: `tokens.css` (every colour, type, spacing, radius, shadow and motion value), `board-night.css` (board colours, replacing chessground's brown theme) and `components.css` (shared primitives). Old custom properties become aliases of the new tokens so the palette changes everywhere in the first commit; each later task moves one screen's rules onto tokens and components and deletes what it replaces. Ratchet tests keep raw colour literals and stray font sizes going down until they reach zero.

**Tech Stack:** Vite 7, plain CSS custom properties, chessground 9, `@fontsource/ibm-plex-sans-thai` 5.3.0, Node `node:test` + happy-dom, Vitest (worker suite).

**Spec:** `docs/superpowers/specs/2026-10-15-night-club-design-system-design.md`

## Global Constraints

- Phase 2 changes appearance only. The only intended behaviour change is the modal focus trap (Task 3); Task 6 also respects `prefers-reduced-motion` for the board animation, as the spec's motion rule requires.
- Dark only. No light mode, no board-theme setting.
- Fonts are self-hosted from `@fontsource/ibm-plex-sans-thai@5.3.0` (OFL-1.1), weights 400, 500, 600, 700. No request to Google Fonts or any other third-party host.
- Token values are copied exactly from the spec tables (sections 1 and 2), including the self-review values `--text-subtle: #8a93a3` and `--loss: #f36e68`.
- No `font-size` below 12px. Weights only 400, 500, 600, 700.
- Class names that tests select on are kept; add classes beside them, never rename. At minimum: `.btn.primary`, `.review-summary-modal`, `.review-modal-overlay`, `.history-row`, `.import-status`, `.quick-status`, `.review-opening`, `.profile-trend`, every `[data-*]` hook.
- Every commit: `npm test` exits 0 and `npx vite build` exits 0.
- Every screen task: check the migrated screens in the built-in browser at 1280×800 and 375×812, compare with screenshots taken before the change, and confirm no console errors.
- At most one `primary` button per view. `danger` buttons are outlined and never take initial focus.
- Minimum hit target 40px; 44px under 600px wide.
- File and code text is neutral and professional (no persona, no emoji).

## Review Focus

1. **Thai glyphs fall back to the system font.** fontsource's subset files (`thai-400.css`, `latin-400.css`) declare no `unicode-range`, so importing two of them makes the second face replace the first and Thai renders in the fallback. Import the weight files (`400.css` … `700.css`), which carry `unicode-range`. Pinned by the Task 1 browser check that `document.fonts.check('16px "IBM Plex Sans Thai"', 'ถึงตาของคุณ')` is true and the computed `font-family` resolves to Plex.
2. **Board size shifts when the font changes.** The board size formula subtracts `--board-chrome` and `--bars-h`, but player bar height currently follows its content. Expected: board width unchanged at 627px (1280×800) and 348px (375×812). Pinned in Task 6 by fixing bar heights to the tokens and measuring `cg-board` width before and after.
3. **Focus trap with content added after the modal opens.** The review summary and game-over card append buttons after `openModal` returns. Expected: Tab still reaches them. Pinned in Task 3 by a test that appends a button after opening and tabs to it.
4. **Thai stacked vowels clipped in fixed-height controls** (chips, segmented items, 40px buttons). Expected: strings such as `ที่นั่ง`, `ผู้ชม`, `ญี่ปุ่น` show their upper and lower marks fully. Pinned by the browser check in Tasks 5 to 10, and by the `components.css` rule that controls use `min-height`, never `height` with `overflow: hidden`.
5. **Long modals on phones.** Under 600px the modal is a bottom sheet. Expected: the review summary scrolls inside the sheet while its title row and close button stay visible. Pinned in Task 3 (CSS test) and Task 9 (browser check at 375×812).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/tokens.css` (create) | Every design value as a custom property on `:root`; global reduced-motion rule; aliases for old variable names until Task 11 |
| `src/board-night.css` (create) | Board square colours, coordinates, highlights; replaces `chessground.brown.css` |
| `src/components.css` (create) | `.btn`, modal, `.screen`, `.card`, `.field`, `.segmented`, `.chip`, `.status-bar` tones, `.toast` |
| `src/styles.css` (modify) | Screen-specific layout only; shrinks every task |
| `src/main.js` (modify) | Stylesheet and font imports; board animation flag |
| `src/ui.js` (modify) | `openModal` sizes and focus trap; `setStatus` tones; `boardAnimationEnabled` |
| `src/controller.js` (modify) | Status tone at each `setStatus` call |
| `src/lobby.js`, `src/review-ui.js`, `src/history-ui.js`, `src/profile-ui.js`, `src/quickplay-ui.js` (modify) | Add component classes to the elements they build |
| `test/design-tokens.test.js` (create) | Token presence and contrast |
| `test/layout-css.test.js` (modify) | Ratchet guards, board and modal CSS rules |
| `test/ui-dialogs.test.js`, `test/online-controller.test.js` (modify) | Focus trap, status tones |
| `package.json` (modify) | Font dependency; register `design-tokens.test.js` |

Stylesheet import order in `src/main.js`, top to bottom: the four `@fontsource/ibm-plex-sans-thai/{400,500,600,700}.css`, `chessground.base.css`, `chessground.cburnett.css`, `./tokens.css`, `./board-night.css`, `./components.css`, `./styles.css`.

---

### Task 1: Tokens, font and aliases

**Files:**
- Create: `src/tokens.css`, `test/design-tokens.test.js`
- Modify: `src/main.js:5-8` (imports), `src/styles.css:3-30` (`:root` block), `package.json`

**Interfaces:**
- Produces: every token name in spec sections 1 and 2 (`--bg`, `--surface-1..3`, `--border`, `--border-strong`, `--text`, `--text-muted`, `--text-subtle`, `--accent`, `--accent-hover`, `--on-accent`, `--gold`, `--on-gold`, `--win`, `--loss`, `--draw`, `--warn`, `--info`, `--scrim`, `--glass`, `--fs-xs..--fs-display`, `--space-1,2,3,4,6,8,12`, `--radius-sm/md/lg/full`, `--shadow-1..3`, `--ring-focus`, `--dur-fast/base/slow`, `--ease-out`, `--font-sans`). Old names alias new ones: `--panel`→`--surface-1`, `--panel-2`→`--surface-2`, `--line`→`--border`, `--muted`→`--text-muted`, `--amber`→`--warn`, `--red`→`--loss`, `--lobby-green`→`--accent`, `--lobby-gold`→`--gold`. `--bg`, `--text`, `--accent`, `--accent-hover`, `--on-accent` keep their names with the new values.

- [ ] **Step 1: Write the failing test** `test/design-tokens.test.js`

```js
const tokens = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8');
const value = (name) => tokens.match(new RegExp(`--${name}:\\s*([^;]+);`, 'u'))?.[1].trim();
// WCAG 2.x relative luminance and contrast for #rrggbb
const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const REQUIRED = ['bg', 'surface-1', 'surface-2', 'surface-3', 'border', 'border-strong', 'text', 'text-muted',
  'text-subtle', 'accent', 'accent-hover', 'on-accent', 'gold', 'on-gold', 'win', 'loss', 'draw', 'warn', 'info',
  'scrim', 'glass', 'fs-xs', 'fs-sm', 'fs-md', 'fs-lg', 'fs-xl', 'fs-2xl', 'fs-3xl', 'fs-display', 'space-1',
  'space-2', 'space-3', 'space-4', 'space-6', 'space-8', 'space-12', 'radius-sm', 'radius-md', 'radius-lg',
  'radius-full', 'shadow-1', 'shadow-2', 'shadow-3', 'ring-focus', 'dur-fast', 'dur-base', 'dur-slow', 'ease-out',
  'font-sans'];
test('every spec token is defined', () => {
  for (const name of REQUIRED) assert.ok(value(name), `--${name}`);
  assert.equal(value('text-subtle'), '#8a93a3');
  assert.equal(value('loss'), '#f36e68');
});
test('text and status tokens reach 4.5:1 on every surface', () => {
  for (const fg of ['text', 'text-muted', 'text-subtle', 'accent', 'gold', 'loss', 'warn', 'info'])
    for (const bg of ['bg', 'surface-1', 'surface-2', 'surface-3'])
      assert.ok(contrast(value(fg), value(bg)) >= 4.5, `${fg} on ${bg}`);
});
test('fill pairs reach 4.5:1', () => {
  assert.ok(contrast(value('on-accent'), value('accent')) >= 4.5);
  assert.ok(contrast(value('on-gold'), value('gold')) >= 4.5);
});
test('no type token below 12px', () => {
  for (const name of ['fs-xs', 'fs-sm', 'fs-md', 'fs-lg', 'fs-xl', 'fs-2xl', 'fs-3xl'])
    assert.ok(parseFloat(value(name)) >= 12, `--${name}`);
  assert.equal(value('fs-display'), 'clamp(28px, 4vw, 44px)');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/design-tokens.test.js`
Expected: FAIL (`ENOENT … src/tokens.css`)

- [ ] **Step 3: Create `src/tokens.css`** with the spec values, `--font-sans: 'IBM Plex Sans Thai', 'Noto Sans Thai', system-ui, sans-serif`, the old-name aliases from Interfaces, and `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; } }`. Keep the layout variables (`--vh`, `--board-chrome`, `--bars-h`, `--board-cap`, `--side-w`, `--eval-*`) in `styles.css`.

- [ ] **Step 4: Remove the colour definitions from the `styles.css` `:root` block** (they now come from `tokens.css`), set `body { font-family: var(--font-sans); }`.

- [ ] **Step 5: Install and import the font**

Run: `npm install @fontsource/ibm-plex-sans-thai@5.3.0`
Then add the four weight imports and `./tokens.css` to `src/main.js` in the order given under File Structure, and add `test/design-tokens.test.js` to `test:domain` in `package.json`.

- [ ] **Step 6: Run the tests and build**

Run: `npm test` then `npx vite build`
Expected: both exit 0; `dist/assets/` contains `ibm-plex-sans-thai-thai-400-normal-<hash>.woff2` (hashed name, so `HASHED_ASSET` in `public/sw.js` caches it as immutable).

- [ ] **Step 7: Browser check** at 1280×800 and 375×812 (home, a bot game, lobby): `document.fonts.check('16px "IBM Plex Sans Thai"', 'ถึงตาของคุณ')` returns true; the palette is the new one on every screen; record `cg-board` width at both sizes for Task 6 (expected 627px and 348px).

- [ ] **Step 8: Commit**

```bash
git add src/tokens.css src/styles.css src/main.js package.json package-lock.json test/design-tokens.test.js
git commit -m "feat(ui): add Night Club design tokens and self-hosted IBM Plex Sans Thai"
```

### Task 2: Night board

**Files:**
- Create: `src/board-night.css`
- Modify: `src/main.js` (drop `chessground.brown.css`, import `./board-night.css` after `tokens.css`), `src/styles.css:458-480` (move the phase 1 coordinate rules into `board-night.css`), `test/layout-css.test.js`

**Interfaces:**
- Consumes: `--gold`, `--accent`, `--loss` from Task 1.
- Produces: `--board-light: #cfd8dc`, `--board-dark: #466f68`, `--board-coord-on-light: #2f4f49`, `--board-coord-on-dark: #f2f5f7`, `--board-last-move`, `--board-selected`, `--board-check` (values in spec section 1).

- [ ] **Step 1: Write the failing tests** in `test/layout-css.test.js`

```js
test('the night board replaces the brown theme', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /chessground\.brown\.css/u);
  assert.match(main, /import '\.\/board-night\.css';/u);
  const board = readFileSync(new URL('../src/board-night.css', import.meta.url), 'utf8');
  for (const name of ['board-light', 'board-dark', 'board-coord-on-light', 'board-coord-on-dark', 'board-last-move', 'board-selected', 'board-check'])
    assert.match(board, new RegExp(`--${name}:`, 'u'));
});
```

Add to `test/design-tokens.test.js`: both coordinate pairs reach 4.5:1 against their squares (read from `board-night.css`).

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/layout-css.test.js test/design-tokens.test.js`
Expected: FAIL (brown import still present; `board-night.css` missing)

- [ ] **Step 3: Write `src/board-night.css`**: `cg-board` background is an inline SVG data URI with an 8×8 two-colour pattern (`#cfd8dc` / `#466f68`, the same technique as `chessground.brown.css`); `square.last-move`, `square.selected`, `square.move-dest`, `square.premove-dest`, `square.check` use the board tokens; rank and file coordinates alternate `--board-coord-on-light` / `--board-coord-on-dark` with the selectors chessground's brown theme uses (`.orientation-white .ranks :nth-child(odd)` and so on); keep the phase 1 rules for weight, opacity and file position, but raise the coordinate size floor to the global 12px minimum: `font-size: clamp(12px, calc(var(--board-size) * 0.022), 14px)` (update the phase 1 assertion in `test/layout-css.test.js` to match).

- [ ] **Step 4: Run the tests** — `npm test` exits 0.

- [ ] **Step 5: Browser check** at both sizes, both orientations: last move, selection, move destinations, check and coordinates are readable; the hint arrow brush (`#f2b900`) is still visible on both square colours.

- [ ] **Step 6: Commit**

```bash
git add src/board-night.css src/main.js src/styles.css test/layout-css.test.js test/design-tokens.test.js
git commit -m "feat(ui): night board theme"
```

### Task 3: Shared components, modal focus trap and ratchet guards

**Files:**
- Create: `src/components.css`
- Modify: `src/ui.js:707-765` (`openModal`), `src/main.js` (import `./components.css` before `./styles.css`), `test/ui-dialogs.test.js`, `test/layout-css.test.js`

**Interfaces:**
- Produces:
  - CSS classes: `.btn` with `.primary`, `.ghost`, `.danger`, `.sm`, `.lg`, `.icon`; `.modal` with `.modal--sm` (420px), `.modal--md` (560px, default), `.modal--lg` (720px), `.modal-head`, `.modal-body`, `.modal-actions`; `.screen`; `.card`, `.card--interactive`; `.field`, `.field-label`, `.field-help`; `.segmented`; `.chip` with `.chip--accent`, `.chip--gold`, `.chip--info`, `.chip--neutral`; `.status-bar` with `.tone-turn`, `.tone-thinking`, `.tone-win`, `.tone-loss`, `.tone-draw`, `.tone-warn`, `.tone-error`; `.toast` with `.toast--info|success|warn|danger`.
  - `ui.openModal(title, bodyEl, { size = 'md' } = {})` → `{ close, body }` (unchanged return shape; the third argument is new and optional).

- [ ] **Step 1: Write the failing tests**

In `test/ui-dialogs.test.js`:

```js
test('Tab and Shift+Tab stay inside an open modal, including buttons added after it opened', (t) => {
  const { window, ui } = setup(t);
  const body = document.createElement('div');
  body.innerHTML = '<button id="first">a</button>';
  ui.openModal('T', body);
  const late = document.createElement('button'); late.id = 'last'; body.appendChild(late);
  late.focus();
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(document.activeElement.className, 'modal-close', 'wraps to the first focusable (the close button)');
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(document.activeElement.id, 'last');
});
test('openModal applies the requested size', (t) => {
  const { ui } = setup(t);
  ui.openModal('T', null, { size: 'lg' });
  assert.ok(document.querySelector('.modal').classList.contains('modal--lg'));
});
```

In `test/layout-css.test.js`, the ratchet:

```js
const RAW_COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(/giu;
const COLOUR_BASELINE = 343; // styles.css on 2026-10-15; each screen task lowers it, Task 11 sets 0
const FONT_SIZE_BASELINE = 130; // non-var() font-size declarations in styles.css
test('components.css uses tokens only', () => {
  assert.equal(readCss('components.css').match(RAW_COLOUR), null);
  assert.equal(readCss('components.css').match(/font-size:\s*(?!var\()/gu), null);
});
test('raw colours and font sizes in styles.css only go down', () => {
  assert.ok((readCss('styles.css').match(RAW_COLOUR) ?? []).length <= COLOUR_BASELINE);
  assert.ok((readCss('styles.css').match(/font-size:\s*(?!var\()/gu) ?? []).length <= FONT_SIZE_BASELINE);
});
test('modal becomes a bottom sheet under 600px with sticky head and actions', () => {
  const c = readCss('components.css');
  assert.match(c, /@media \(max-width: 600px\)[\s\S]*?\.modal\s*\{[^}]*align-self:\s*flex-end/u);
  assert.match(c, /\.modal-head\s*\{[^}]*position:\s*sticky/u);
  assert.match(c, /\.modal-actions\s*\{[^}]*position:\s*sticky/u);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/ui-dialogs.test.js test/layout-css.test.js`
Expected: FAIL (no trap, no size class, no `components.css`)

- [ ] **Step 3: Implement the focus trap in `openModal`**: the existing `keydown` listener also handles `Tab`; it collects focusables inside the dialog at keydown time (`button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])`, excluding disabled and hidden) and wraps first↔last. Add `modal--${size}` to `.modal`.

- [ ] **Step 4: Write `src/components.css`** from spec section 3 using tokens only. Controls use `min-height` (40px; 44px under 600px), never a fixed `height` with `overflow: hidden`. `.btn.danger` is outlined (`--loss` text and border, transparent fill). `.modal` overlay uses `--scrim`; `.modal` over imagery uses `--glass` inside `@supports (backdrop-filter: blur(1px))`, `--surface-2` otherwise. Every focusable component uses `box-shadow: var(--ring-focus)` on `:focus-visible`.

- [ ] **Step 5: Run the tests** — `npm test` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/components.css src/ui.js src/main.js test/ui-dialogs.test.js test/layout-css.test.js
git commit -m "feat(ui): shared components, modal sizes and focus trap"
```

### Task 4: Status bar tones

**Files:**
- Modify: `src/ui.js:625-629` (`setStatus`), `src/controller.js` (17 `setStatus` calls with `'busy'`, `'done'`, `'err'`, plus the "your turn" calls), `src/styles.css:644-672` (delete `.status-bar.busy/.done/.err`), `test/online-controller.test.js`

**Interfaces:**
- Consumes: `.status-bar.tone-*` from Task 3; `_viewerOutcome(result)` (phase 1, `src/controller.js`).
- Produces: `ui.setStatus(text, tone = '')` where `tone` ∈ `'' | 'turn' | 'thinking' | 'win' | 'loss' | 'draw' | 'warn' | 'error'`; the class applied is `status-bar tone-${tone}` (or `status-bar` for `''`).

- [ ] **Step 1: Write the failing test** in `test/online-controller.test.js` (extend the harness `ui` with `setStatus(text, tone) { calls.status = [text, tone]; }`):

```js
test('the status bar tone follows the game from the player side', async (t) => {
  // Bot game as White: after e2e4 the engine thinks; resigning is a loss.
  await controller.start(MODES.HUMAN_VS_AI, { color: 'w', level: 4, timeControlId: 'unlimited' });
  await controller.handleUserMove('e2', 'e4');
  assert.equal(calls.status[1], 'thinking');
  controller.resign();
  assert.equal(calls.status[1], 'loss');
  // Online host (White) receives a finished 1-0, then a 1/2-1/2 in a fresh room.
  controller._onOnlineState(stateAfter(['e2e4'], { status: 'finished', result: '1-0', reason: 'resignation' }));
  assert.equal(calls.status[1], 'win');
  // ...fresh harness: result '1/2-1/2', reason 'agreement' -> 'draw'
  // Sandbox (ANALYZE) fool's mate f2f3 e7e5 g2g4 d8h4 -> ''
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/online-controller.test.js`
Expected: FAIL (tones are still `busy` / `done`)

- [ ] **Step 3: Map every call**: `'busy'` → `'thinking'`; `'err'` → `'error'`; the four game-end calls (`_onClockTimeout`, `resign`, `_announceGameOver`, `_announceOnlineResult`) pass `this._viewerOutcome(result) ?? ''`; calls whose text is "ถึงตาของคุณ" pass `'turn'`; AFK and connection-loss messages pass `'warn'`.

- [ ] **Step 4: Run the tests** — `npm test` exits 0.

- [ ] **Step 5: Browser check**: lose a bot game by resigning → red status bar; win against an engine position set up in sandbox → green; engine thinking → info tone.

- [ ] **Step 6: Commit** — `git commit -m "feat(ui): status bar tones follow the player's outcome"`

### Task 5: Home and shell (migration commit 1)

**Files:**
- Modify: `src/styles.css` (top bar, `.park-*` home hero, quick play, `.chesscom-play-card`, `.modal-mode-cards-vertical`), `src/main.js` (mode picker: cards get `card card--interactive`, tags get `chip chip--*`, buttons get `.btn` variants), `test/layout-css.test.js` (lower baselines)

**Interfaces:**
- Consumes: Task 3 classes. `tag-cyan`→`chip--info`, `tag-green`→`chip--accent`, `tag-amber`→`chip--gold`, `tag-purple`→`chip--neutral`.

- [ ] **Step 1: Take before-screenshots** of home and the mode picker (steps 1 and 2 for every mode) at 1280×800 and 375×812.
- [ ] **Step 2: Replace these screens' colours, sizes, radii and shadows with tokens; drop rules that the component classes now cover.** Keep the 3D artwork; overlays on it use `--scrim`.
- [ ] **Step 3: Lower `COLOUR_BASELINE` and `FONT_SIZE_BASELINE`** to the new counts (`node -e` over `styles.css` with the two regexes from Task 3) and run `npm test` — exit 0.
- [ ] **Step 4: Browser check** against the before-screenshots: one primary button per view; Quick Play visible; focus ring visible on Tab; Thai marks unclipped; no console errors. `npx vite build` exits 0.
- [ ] **Step 5: Commit** — `git commit -m "style(ui): migrate home and mode picker to Night Club tokens"`

### Task 6: Game screen (migration commit 2)

**Files:**
- Modify: `src/styles.css` (`.player-bar`, `.clock-badge`, `.action-strip`, `.action-btn`, `.sidebar*`, move list and tabs, sandbox panels, `.promo-*`), `src/ui.js` (export `boardAnimationEnabled(matchMediaImpl = globalThis.matchMedia)` → `boolean`), `src/main.js` (Chessground `animation.enabled: boardAnimationEnabled()`; promotion picker uses `ui.openModal(title, body, { size: 'sm' })`), `test/ui-dialogs.test.js`, `test/layout-css.test.js`

**Interfaces:**
- Consumes: Task 3 `openModal` size option and `.segmented`; Task 4 tones.
- Produces: `boardAnimationEnabled(matchMediaImpl)` returns `false` when `matchMediaImpl('(prefers-reduced-motion: reduce)').matches` is true, `true` otherwise (also `true` when `matchMediaImpl` is undefined).

- [ ] **Step 1: Write the failing tests**: `boardAnimationEnabled` with a stub returning `{ matches: true }` → `false`, `{ matches: false }` → `true`, `undefined` → `true`; CSS test that `.player-bar` sets `height: calc(var(--bars-h) / 2)` and `box-sizing: border-box`; CSS test that `.clock-badge` uses `font-variant-numeric: tabular-nums`.
- [ ] **Step 2: Run them to verify they fail** — `node --test test/ui-dialogs.test.js test/layout-css.test.js` → FAIL.
- [ ] **Step 3: Before-screenshots** of a bot game, an online game, sandbox setup and the promotion picker at both sizes.
- [ ] **Step 4: Migrate the rules**; pin `.player-bar` height to `calc(var(--bars-h) / 2)` (the 1000px breakpoint keeps its own `--bars-h: 84px`); moves/log tabs use `.segmented`; action strip buttons are `.btn.ghost.icon` with labels.
- [ ] **Step 5: Verify tabular digits**: in the browser, the widths of `1:11` and `0:00` in `.clock-badge` are equal. If not, `npm install @fontsource/jetbrains-mono@5.3.0`, import `latin-600.css`, and set `.clock-badge { font-family: 'JetBrains Mono', var(--font-sans) }`.
- [ ] **Step 6: Lower the baselines, run `npm test` and `npx vite build`** — both exit 0.
- [ ] **Step 7: Browser check**: `cg-board` width is still 627px at 1280×800 and 348px at 375×812 (values recorded in Task 1); no page overflow; clocks do not shift while counting; no console errors.
- [ ] **Step 8: Commit** — `git commit -m "style(ui): migrate the game screen to Night Club tokens"`

### Task 7: Game-over card and dialogs (migration commit 3)

**Files:**
- Modify: `src/ui.js` (`showGameOver`, `_spawnGameOverPill`, `showFloatingToast`, `setAfkWarning`, `confirm` — add `.modal-actions`, `.toast--*`, `.chip` classes), `src/main.js` (options and share dialogs), `src/styles.css` (`.gameover*`, `.floating-toast*`, `.afk-*`, `.option-item-*`, `.share-*`), `test/ui-dialogs.test.js`

**Interfaces:**
- Consumes: Task 3 classes; phase 1 `gameover-title--win|loss|draw` and `ui.confirm()`.

- [ ] **Step 1: Write the failing test**: `ui.confirm({ danger: true, … })` renders its buttons inside `.modal-actions`, and the danger button has classes `btn danger` without `primary`; `showFloatingToast({ title, tone: 'warn' })` adds `toast toast--warn` (new optional `tone` parameter, default `'info'`).
- [ ] **Step 2: Run it to verify it fails** — `node --test test/ui-dialogs.test.js` → FAIL.
- [ ] **Step 3: Implement**; the review-disconnect toast in `controller.js` passes `tone: 'warn'`. Before-screenshots first.
- [ ] **Step 4: Lower the baselines, `npm test`, `npx vite build`** — exit 0.
- [ ] **Step 5: Browser check**: win, loss and draw cards, minimized pill, options, resign and leave confirmations, AFK countdown in an online game.
- [ ] **Step 6: Commit** — `git commit -m "style(ui): migrate game-over card, toasts and dialogs"`

### Task 8: Lobby (migration commit 4)

**Files:**
- Modify: `src/lobby.js` (root gets `screen` beside `live-lobby-overlay`; filters use `.segmented`; room buttons use `.btn`), `src/main.js` (private join overlay gets `screen` beside `join-lobby-overlay`), `src/styles.css` (`.live-lobby-*`, `.lobby-*`, `.join-lobby-overlay`, `.exact-*`; remove `--lobby-hall-url` gradient colours in favour of tokens), `test/lobby-ui.test.js`

**Interfaces:**
- Consumes: `.screen`, `.card--interactive`, `.chip`, `.segmented`, `.btn`.

- [ ] **Step 1: Write the failing test**: the lobby root has class `screen`; each room card has `card card--interactive`; the status, time and spectator labels are `.chip` elements.
- [ ] **Step 2: Run it to verify it fails** — `node --test test/lobby-ui.test.js` → FAIL.
- [ ] **Step 3: Implement** (before-screenshots first, with the local worker running so cards exist: `.env.local` with `VITE_ONLINE_API_URL=http://127.0.0.1:8787`, `npx wrangler dev --port 8787`; delete `.env.local` afterwards).
- [ ] **Step 4: Lower the baselines, `npm test`, `npx vite build`** — exit 0.
- [ ] **Step 5: Browser check** at both sizes: open, watch and unavailable cards; load more; unconfigured-server message; no home screen showing through.
- [ ] **Step 6: Commit** — `git commit -m "style(ui): migrate the lobby to the shared screen and card components"`

### Task 9: Review (migration commit 5)

**Files:**
- Modify: `src/review-ui.js` (summary and progress modals add `modal modal--lg` beside `review-modal`, keeping `review-summary-modal` and `review-modal-overlay`; coach card and stepper buttons use `.btn`), `src/styles.css` (`.review-*`, `.gauge-*`, `.tier-*`, `.advantage-*`, `.coach-*`, `.cm-btn`, `.step-btn`), `test/review-critical.test.js`

**Interfaces:**
- Consumes: modal classes and `.btn` from Task 3. Tier colours stay as the `TIERS` data in `src/analyzer.js` (they are data, not theme).

- [ ] **Step 1: Write the failing test**: the summary overlay's dialog has `modal--lg` and still matches `.review-summary-modal`; its close button is inside `.modal-head`.
- [ ] **Step 2: Run it to verify it fails** — `node --test test/review-critical.test.js` → FAIL.
- [ ] **Step 3: Implement**; the summary title drops the teal gradient for `--text`; the advantage graph uses `--accent` for White's area and `--surface-3` for the grid. Before-screenshots first.
- [ ] **Step 4: Lower the baselines, `npm test`, `npx vite build`** — exit 0.
- [ ] **Step 5: Browser check** at both sizes: summary scrolls inside the bottom sheet at 375×812 with the close button visible; stepper, coach card, puzzle retry and eval bar readable.
- [ ] **Step 6: Commit** — `git commit -m "style(ui): migrate game review to Night Club components"`

### Task 10: History, profile, import and Quick Play (migration commit 6)

**Files:**
- Modify: `src/history-ui.js`, `src/profile-ui.js`, `src/quickplay-ui.js` (add `.btn`, `.card`, `.field`, `.chip` classes), `src/styles.css` (`.history-*`, `.profile-*`, `.import-*`, `.quick-*`), `test/history-ui.test.js`

**Interfaces:**
- Consumes: Task 3 classes; phase 1 `history-result--*`.

- [ ] **Step 1: Write the failing test**: every row action in the history list is a `.btn.sm` with a rendered `min-height` rule of at least 40px in `components.css` (CSS assertion), and rows keep the `.history-row` class.
- [ ] **Step 2: Run it to verify it fails** — `node --test test/history-ui.test.js test/layout-css.test.js` → FAIL.
- [ ] **Step 3: Implement** (before-screenshots first); remove the `outline: none` on `.import-text:focus`.
- [ ] **Step 4: Lower the baselines, `npm test`, `npx vite build`** — exit 0.
- [ ] **Step 5: Browser check** at both sizes: history list, clear confirmation, profile stats, PGN import with an error, Quick Play search.
- [ ] **Step 6: Commit** — `git commit -m "style(ui): migrate history, profile, import and quick play"`

### Task 11: Cleanup and final walkthrough (migration commit 7)

**Files:**
- Modify: `src/tokens.css` (delete the old-name aliases), `src/styles.css` (rename remaining uses of old names to new tokens; delete rules no selector reaches), `test/layout-css.test.js`

- [ ] **Step 1: Set `COLOUR_BASELINE = 0` and `FONT_SIZE_BASELINE = 0`**, and add a test that `tokens.css` defines none of `--panel`, `--panel-2`, `--line`, `--muted`, `--amber`, `--red`, `--lobby-green`, `--lobby-gold`.
- [ ] **Step 2: Run them to verify they fail** — `node --test test/layout-css.test.js test/design-tokens.test.js` → FAIL on the remaining counts.
- [ ] **Step 3: Remove the remaining literals and aliases** until both tests pass.
- [ ] **Step 4: `npm test` and `npx vite build`** — exit 0.
- [ ] **Step 5: Full walkthrough** at 1280×800 and 375×812: every screen from Tasks 5 to 10, plus a two-player online game against the local worker (create, join from the lobby, play, resign, rematch, spectate). No console or worker errors.
- [ ] **Step 6: Commit** — `git commit -m "style(ui): remove legacy colour aliases and literals"`
