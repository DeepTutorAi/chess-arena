// Game Review System — UI manager (plan.md §7 Step 2).
// Owns every review surface: analysis progress modal, the Obsidian-glass
// summary modal (accuracy gauges, tier table, advantage graph), and the
// docked replay stepper. The live game UI is REPLACED while reviewing —
// never stacked on top of it.

import { Chess } from 'chess.js';
import { sounds } from './sounds.js';
import { ChessClock } from './clock.js';
import { Stockfish } from './engine.js';
import { TIERS, TIER_BY_KEY, pvToSan, ANALYSIS_DEPTH, convertCentipawnsToWinProbability } from './analyzer.js';
import { iconBarChart, iconTrendingUp, iconFlip } from './icons.js';
import { escapeHtml } from './html.js';

const BAD_TIERS = new Set(['inaccuracy', 'mistake', 'blunder', 'miss']);
const RETRYABLE_TIERS = new Set(['inaccuracy', 'mistake', 'blunder', 'miss']);
// Beat between the user's wrong move landing and the opponent's answer — long
// enough to SEE the played move, short enough to feel responsive.
const RETRY_REPLY_DELAY_MS = 650;

const HEADLINES = {
  brilliant: 'ตาเดินสุดฉลาด (Brilliant)',
  great: 'ตาที่มีเดียวที่เล่นได้ (Great)',
  best: 'ตาที่ดีที่สุด (Best)',
  excellent: 'ตาที่ยอดเยี่ยม (Excellent)',
  good: 'ตาที่แน่นอน (Good)',
  book: 'ตาตามทฤษฎีเปิด (Book)',
  inaccuracy: 'ความคลาดเคลื่อนเล็กน้อย (Inaccuracy)',
  mistake: 'ตาเดินผิดพลาด (Mistake)',
  blunder: 'ตาเดินผิดพลาดร้ายแรง (Blunder)',
  miss: 'พลาดโอกาสสำคัญ (Miss)',
};

export class CoachService {
  constructor(ttsProvider = null) {
    this.ttsProvider = ttsProvider; // null = silent visual mode (TTS later)
  }

  generateInsight(ply) {
    const tier = TIER_BY_KEY[ply.tier];
    const lost = ply.deltaW > 0;
    let explanation;
    if (ply.tier === 'book') {
      explanation = `การเดิน ${ply.san} เป็นตามาตรฐานของการเปิดเกม ยังไม่มีความเสียเปรียบเกิดขึ้น`;
    } else if (!lost) {
      explanation = ply.bestSan && ply.bestSan !== ply.san
        ? `การเดิน ${ply.san} รักษาความได้เปรียบไว้ได้เท่าตาที่ดีที่สุด (${ply.bestSan}) — เอนจินยืนยันว่าเล่นได้แล้ว`
        : `การเดิน ${ply.san} คือตาที่เอนจินเลือก รักษาความได้เปรียบเอาไว้เต็มที่`;
    } else {
      const betterPart = ply.bestSan ? `ตาที่ดีกว่าคือ ${ply.bestSan} (ตามลูกศรเขียว)` : 'มีตาที่รักษาเปรียบเทียบได้ดีกว่า';
      // cpLoss is centipawns; a missed/allowed mate is clamped to ±10000, which
      // is not a meaningful number of pawns.
      const pawns = ply.cpLoss > 0 && ply.cpLoss < 5000 ? ` (~${(Math.round(ply.cpLoss / 10) / 10).toFixed(1)} ตัว)` : '';
      explanation = `การเดิน ${ply.san} เสียความได้เปรียบ ${ply.deltaW}%${pawns} — ${betterPart}`;
      if (ply.replySan) explanation += ` ระวังการตอบโต้ ${ply.replySan} ของฝ่ายตรงข้าม`;
    }
    const tacticalTag = (ply.tier === 'miss' && 'Missed Tactics')
      || (ply.captured && 'Material Swing')
      || (ply.bestMove && ply.bestMove.from === ply.from && ply.bestMove.to === ply.to && 'Engine Top Move')
      || (BAD_TIERS.has(ply.tier) ? 'Positional Error' : 'Solid Play');
    return {
      plyIndex: ply.ply,
      tier: ply.tier,
      headline: HEADLINES[ply.tier] ?? ply.tier,
      explanation,
      tacticalTag,
      winProbLoss: ply.deltaW,
      centipawnLoss: -ply.cpLoss,
      speechScript: `ตาที่ ${Math.floor(ply.ply / 2) + 1} ${ply.color === 'w' ? 'ขาว' : 'ดำ'} เดิน ${ply.san} ${HEADLINES[ply.tier] ?? ''}`,
    };
  }

  speak(insight) {
    if (!this.ttsProvider) return; // silent mode until a TTS provider registers
    this.ttsProvider.synthesizeAndPlay(insight.speechScript);
  }
}

/** Engine score is side-to-move pawn units (number) or a mate string. */
function formatSimScore(score) {
  if (typeof score === 'number') return `(${score >= 0 ? '+' : ''}${score.toFixed(1)})`;
  if (typeof score === 'string' && score) return `(${score})`;
  return '';
}

export class ReviewUI {
  constructor() {
    this._progressOverlay = null;
    this._summaryOverlay = null;
    this._panel = null;
    this._badgeLayer = null;
    this._controller = null;
    this._analysis = null;
    this._viewPly = -1;      // -1 = initial position; N-1 = last played move
    this._keyboardHandler = null;
    this._autoplayTimer = null;
    this._retry = null;      // active retry-sim session (see startRetryMistake)
    this._simReplyTimer = null;
    this._puzzleRun = null;  // active puzzle-run session (see startPuzzleRun)
    this._coach = new CoachService();
    this._graphTooltip = null;
    this._forecastEngine = null; // per-retry-session worker for simulated replies
  }

  // ---- analysis progress -------------------------------------------------
  showProgressModal(onCancel) {
    this.closeProgressModal();
    const overlay = document.createElement('div');
    overlay.className = 'review-modal-overlay';
    overlay.innerHTML = `
      <div class="review-modal review-progress-modal" role="dialog" aria-modal="true" aria-label="กำลังวิเคราะห์เกม">
        <button class="review-modal-close" type="button" aria-label="ยกเลิกการวิเคราะห์">✕</button>
        <div class="review-progress-icon">${iconBarChart({ size: 28 })}</div>
        <div class="review-progress-title">กำลังวิเคราะห์รูปเกม…</div>
        <div class="review-progress-sub" data-sub>เตรียมเอนจิน</div>
        <div class="review-progress-track"><div class="review-progress-fill" data-fill style="width:0%"></div></div>
        <div class="review-progress-pct" data-pct>0%</div>
        <button class="btn review-progress-cancel" type="button" data-cancel>ยกเลิก</button>
      </div>
    `;
    overlay.querySelector('[data-cancel]').onclick = () => onCancel?.();
    overlay.querySelector('.review-modal-close').onclick = () => onCancel?.();
    document.body.appendChild(overlay);
    this._progressOverlay = overlay;
  }

  updateProgress(percentage, currentPly, totalPlies) {
    if (!this._progressOverlay) return;
    const fill = this._progressOverlay.querySelector('[data-fill]');
    fill.style.width = `${percentage}%`;
    this._progressOverlay.querySelector('[data-pct]').textContent = `${percentage}%`;
    this._progressOverlay.querySelector('[data-sub]').textContent =
      `ตำแหน่งที่ ${currentPly}/${totalPlies} (ความลึก 12)`;
  }

  closeProgressModal() {
    this._progressOverlay?.remove();
    this._progressOverlay = null;
  }

  // ---- summary modal -------------------------------------------------------
  showReviewSummaryModal(analysis, onStepThrough, onNewGame, onExit, onPuzzleRun = null) {
    this.closeSummaryModal();
    this.closeProgressModal();
    const overlay = document.createElement('div');
    overlay.className = 'review-modal-overlay';
    // null = that side never moved (1-ply game): shown as "—", not a fake 0%.
    const whiteAcc = analysis.accuracy.w ?? null;
    const blackAcc = analysis.accuracy.b ?? null;
    const runCount = analysis.plies.filter((p) => RETRYABLE_TIERS.has(p.tier) && p.bestMove).length;
    overlay.innerHTML = `
      <div class="review-modal review-summary-modal" role="dialog" aria-modal="true" aria-label="สรุปการรีวิวเกม">
        <button class="review-modal-close" type="button" aria-label="ปิด">✕</button>
        <div class="review-summary-title">Game Review · การรีวิวเกม</div>
        ${analysis.opening ? `<div class="review-opening">📖 ${escapeHtml(analysis.opening.eco)} · ${escapeHtml(analysis.opening.name)}</div>` : ''}

        <div class="review-section-label">ACCURACY SECTION</div>
        <div class="review-gauges">
          ${this._gaugeSvg(whiteAcc, 'White', analysis.players.white?.name)}
          ${this._gaugeSvg(blackAcc, 'Black', analysis.players.black?.name)}
        </div>

        <div class="review-section-label">MOVE STATS BREAKDOWN</div>
        <div class="review-tier-table" data-tiers></div>
        ${(analysis.criticalMoments?.length) ? `
        <div class="review-section-label">CRITICAL MOMENTS · จังหวะชี้ขาด</div>
        <div class="review-critical-row" data-critical></div>` : ''}

        <div class="review-section-label">ADVANTAGE GRAPH</div>
        <div class="advantage-graph-wrap">
          ${this._advantageGraphSvg(analysis)}
          <div class="advantage-tooltip" data-tooltip hidden></div>
        </div>

        <div class="review-summary-actions">
          <button class="btn primary review-step-btn" type="button" data-step>
            🔍 ดูตาเดินบนกระดาน (Review Moves)
          </button>
          ${runCount ? `<button class="btn primary review-puzzle-btn" type="button" data-puzzle-run>🎯 ฝึกแก้ตาพลาด (${runCount} ตา)</button>` : ''}
          <button class="btn" type="button" data-again>↺ เล่นกันใหม่</button>
        </div>
      </div>
    `;

    overlay.querySelector('[data-puzzle-run]')?.addEventListener('click', () => {
      this.closeSummaryModal();
      onPuzzleRun?.();
    });

    const tierTable = overlay.querySelector('[data-tiers]');
    for (const tier of TIERS) {
      const count = (analysis.counts.w?.[tier.key] ?? 0) + (analysis.counts.b?.[tier.key] ?? 0);
      const cell = document.createElement('div');
      cell.className = `tier-cell tier-${tier.key}`;
      cell.innerHTML = `
        <span class="tier-symbol" style="color:${tier.color}">${tier.symbol}</span>
        <span class="tier-name">${tier.label}</span>
        <span class="tier-count" style="color:${tier.color}">${count}</span>
      `;
      tierTable.appendChild(cell);
    }

    const criticalRow = overlay.querySelector('[data-critical]');
    for (const m of analysis.criticalMoments ?? []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `cm-btn ${m.lost ? 'cm-lost' : 'cm-gain'}`;
      btn.innerHTML = `
        <span class="cm-move">ตา ${Math.floor(m.ply / 2) + 1} · ${escapeHtml(m.san)}</span>
        <span class="cm-swing">${m.lost ? 'เสีย' : 'ได้'} ${m.swingPct}%</span>
      `;
      btn.onclick = () => {
        this.closeSummaryModal();
        onStepThrough(m.ply);
      };
      criticalRow.appendChild(btn);
    }

    overlay.querySelector('[data-step]').onclick = () => {
      this.closeSummaryModal();
      onStepThrough(0); // review always starts from the very first move
    };
    overlay.querySelector('[data-again]').onclick = () => {
      this.closeSummaryModal();
      onNewGame?.();
    };
    overlay.querySelector('.review-modal-close').onclick = () => {
      this.closeSummaryModal();
      onExit?.();
    };
    document.body.appendChild(overlay);
    this._summaryOverlay = overlay;
    // Wire after mount — hover math reads live layout boxes.
    this._wireAdvantageGraph(overlay, analysis, (ply) => {
      this.closeSummaryModal();
      onStepThrough(ply);
    });
  }

  closeSummaryModal() {
    if (this._summaryOverlay) {
      this._summaryOverlay.remove();
      this._summaryOverlay = null;
    }
  }

  _gaugeSvg(accuracy, sideLabel, playerName) {
    const radius = 52;
    const circumference = 2 * Math.PI * radius;
    const hasValue = typeof accuracy === 'number';
    const offset = circumference * (1 - (hasValue ? Math.max(0, Math.min(100, accuracy)) : 0) / 100);
    const pctText = hasValue ? `${accuracy}%` : '—';
    return `
      <div class="accuracy-gauge">
        <svg class="accuracy-gauge-svg" viewBox="0 0 120 120" role="img" aria-label="${escapeHtml(sideLabel)} accuracy ${hasValue ? `${accuracy}%` : 'not available'}">
          <circle class="gauge-track" cx="60" cy="60" r="${radius}"></circle>
          <circle class="gauge-fill" cx="60" cy="60" r="${radius}"
            stroke-dasharray="${circumference.toFixed(1)}"
            stroke-dashoffset="${offset.toFixed(1)}"></circle>
          <text class="gauge-pct" x="60" y="56">${pctText}</text>
          <text class="gauge-side" x="60" y="74">${escapeHtml(sideLabel)}</text>
        </svg>
        <span class="gauge-name">${escapeHtml(playerName || (sideLabel === 'White' ? 'ฝ่ายขาว' : 'ฝ่ายดำ'))}</span>
      </div>
    `;
  }

  _advantageGraphSvg(analysis) {
    const W = 560;
    const H = 150;
    const pts = analysis.positions;
    const x = (i) => pts.length > 1 ? (i / (pts.length - 1)) * W : 0;
    const y = (whiteProb) => H - (whiteProb / 100) * H;
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.whiteWinProb).toFixed(1)}`).join(' ');
    const area = `${line} L${W},${H} L0,${H} Z`;
    const tickCount = Math.min(5, Math.max(1, Math.floor(pts.length / 2)));
    let ticks = '';
    for (let t = 0; t < tickCount; t++) {
      const idx = Math.round((t / Math.max(1, tickCount - 1)) * (pts.length - 1));
      ticks += `<text class="adv-tick" x="${x(idx).toFixed(1)}" y="${H + 14}">ตา ${idx}</text>`;
    }
    return `
      <svg class="advantage-graph-svg" viewBox="0 0 ${W} ${H + 22}" preserveAspectRatio="none" role="img" aria-label="กราฟความได้เปรียบ">
        <defs>
          <linearGradient id="adv-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#2fd6c3" stop-opacity="0.35"></stop>
            <stop offset="100%" stop-color="#2fd6c3" stop-opacity="0.02"></stop>
          </linearGradient>
        </defs>
        <line class="adv-centerline" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}"></line>
        <path class="adv-area" d="${area}" fill="url(#adv-fill)"></path>
        <path class="adv-line" d="${line}"></path>
        <line class="adv-crosshair" data-crosshair x1="0" y1="0" x2="0" y2="${H}" style="display:none"></line>
        ${ticks}
        ${(analysis.criticalMoments ?? []).map((m) => {
          const cx = x(m.ply + 1).toFixed(1);
          const cy = y(analysis.positions[m.ply + 1]?.whiteWinProb ?? 50).toFixed(1);
          return `<circle class="adv-cm-dot" data-ply="${m.ply}" cx="${cx}" cy="${cy}" r="4"><title>จังหวะชี้ขาด: ${m.san} (${m.lost ? 'เสีย' : 'ได้'} ${m.swingPct}%)</title></circle>`;
        }).join('')}
      </svg>
    `;
  }

  _wireAdvantageGraph(overlay, analysis, onPickPly) {
    const svg = overlay.querySelector('.advantage-graph-svg');
    const tooltip = overlay.querySelector('[data-tooltip]');
    const crosshair = overlay.querySelector('[data-crosshair]');
    const wrap = overlay.querySelector('.advantage-graph-wrap');
    const total = analysis.positions.length;
    const jump = (ply) => {
      const p = analysis.positions[ply];
      crosshair.setAttribute('x1', String(ply * (560 / Math.max(1, total - 1))));
      crosshair.setAttribute('x2', String(ply * (560 / Math.max(1, total - 1))));
      crosshair.style.display = ''; // SVG has no `hidden` property
      const moveLabel = ply > 0 ? `${analysis.plies[ply - 1].san}` : 'เริ่มเกม';
      tooltip.hidden = false;
      tooltip.innerHTML = `<b>${escapeHtml(moveLabel)}</b> · ขาว ${p.whiteWinProb}% (${(p.whiteEvalCp / 100).toFixed(1)})`;
      const wrapRect = wrap.getBoundingClientRect();
      const ratio = total > 1 ? ply / (total - 1) : 0;
      tooltip.style.left = `clamp(0px, calc(${(ratio * 100).toFixed(2)}% - 40px), ${Math.max(0, wrapRect.width - 90)}px)`;
    };
    svg.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      jump(Math.round(ratio * (total - 1)));
    });
    svg.addEventListener('mouseleave', () => {
      crosshair.style.display = 'none';
      tooltip.hidden = true;
    });
    svg.addEventListener('click', (e) => {
      const rect = svg.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      // Graph positions count plies played (0 = start); the stepper indexes the
      // move just played (-1 = start), so position p is stepper ply p - 1.
      onPickPly(Math.round(ratio * (total - 1)) - 1);
    });
    // Critical-moment markers jump straight to the swing ply (roadmap A1).
    svg.querySelectorAll('.adv-cm-dot').forEach((dot) => {
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        onPickPly(Number(dot.dataset.ply));
      });
    });
  }

  // ---- board stepper (docked review mode) --------------------------------
  enterStepperMode(controller, analysis, startPly = 0) {
    this.exitStepperMode();
    this._controller = controller;
    this._analysis = analysis;

    // Replace the game sidebar with the review panel — review mode owns the
    // screen; the live-game controls never coexist with it.
    const ui = controller.ui;
    const sidebar = ui.refs.gameSidebar;
    sidebar.querySelector('.sidebar-header').classList.add('hidden');
    sidebar.querySelector('.sidebar-content').classList.add('hidden');
    sidebar.querySelector('.action-strip').classList.add('hidden');
    const panel = document.createElement('div');
    panel.className = 'review-panel';
    panel.innerHTML = `
      <div class="review-panel-head">
        <span class="review-mode-tag">${iconTrendingUp({ size: 14 })} REVIEW MODE</span>
        <div class="review-overview" data-overview></div>
      </div>
      <div class="review-movelist" data-movelist></div>
      <div class="coach-card" data-coach></div>
      <div class="stepper-controls">
        <button class="step-btn" type="button" data-first title="ต้นเกม">|&lt;&lt;</button>
        <button class="step-btn" type="button" data-prev title="ตาก่อน">&lt;</button>
        <button class="step-btn" type="button" data-play title="เล่นอัตโนมัติ">▶</button>
        <button class="step-btn" type="button" data-next title="ตาถัดไป">&gt;</button>
        <button class="step-btn" type="button" data-last title="ตาสุดท้าย">&gt;&gt;|</button>
        <button class="step-btn" type="button" data-flip title="กลับกระดาน">${iconFlip({ size: 15 })}</button>
      </div>
      <button class="btn review-exit-btn" type="button" data-exit>ออกจากการรีวิว</button>
    `;
    sidebar.appendChild(panel);
    this._panel = panel;

    panel.querySelector('[data-first]').onclick = () => this.stepTo(-1, true);
    panel.querySelector('[data-prev]').onclick = () => this.stepTo(this._viewPly - 1, true);
    panel.querySelector('[data-next]').onclick = () => this.stepTo(this._viewPly + 1, true);
    panel.querySelector('[data-last]').onclick = () => this.stepTo(analysis.plies.length - 1, true);
    panel.querySelector('[data-play]').onclick = () => this.toggleAutoplay();
    panel.querySelector('[data-flip]').onclick = () => controller.flip();
    panel.querySelector('[data-exit]').onclick = () => controller.exitReview();

    // On-board badge overlay — a permanent sibling of #board (chessground
    // wipes foreign children of its own element on orientation changes).
    this._badgeLayer = document.getElementById('review-badge-layer');
    this._badgeLayer.classList.remove('hidden');
    this._badgeLayer.innerHTML = '';

    this._renderOverview();
    this._buildMoveList();

    this._keyboardHandler = (event) => {
      if (this._retry || this._puzzleRun) return;
      if (event.key === 'ArrowLeft') this.stepTo(this._viewPly - 1, true);
      else if (event.key === 'ArrowRight') this.stepTo(this._viewPly + 1, true);
      else if (event.key === 'Home') this.stepTo(-1, true);
      else if (event.key === 'End') this.stepTo(analysis.plies.length - 1, true);
      else if (event.key === ' ') {
        event.preventDefault();
        this.toggleAutoplay();
      }
    };
    document.addEventListener('keydown', this._keyboardHandler);

    this.renderStepperPly(startPly);
  }

  exitStepperMode() {
    this._stopSimLine();
    if (this._autoplayTimer) {
      clearInterval(this._autoplayTimer);
      this._autoplayTimer = null;
    }
    if (this._keyboardHandler) {
      document.removeEventListener('keydown', this._keyboardHandler);
      this._keyboardHandler = null;
    }
    const badgeLayer = this._badgeLayer ?? document.getElementById('review-badge-layer');
    if (badgeLayer) {
      badgeLayer.classList.add('hidden');
      badgeLayer.innerHTML = '';
    }
    this._badgeLayer = null;
    this._panel?.remove();
    this._panel = null;
    if (this._controller) {
      const ui = this._controller.ui;
      ui.refs.gameSidebar.querySelector('.sidebar-header')?.classList.remove('hidden');
      ui.refs.gameSidebar.querySelector('.sidebar-content')?.classList.remove('hidden');
      ui.refs.gameSidebar.querySelector('.action-strip')?.classList.remove('hidden');
    }
    this._retry = null;
    this._puzzleRun = null;
    this._controller = null;
    this._analysis = null;
    this._viewPly = -1;
  }

  get active() {
    return Boolean(this._panel);
  }

  stepTo(ply, withSound = false) {
    if (!this._analysis || this._retry || this._puzzleRun) return;
    const clamped = Math.max(-1, Math.min(this._analysis.plies.length - 1, ply));
    if (clamped === this._viewPly) return;
    this.renderStepperPly(clamped);
    if (withSound) sounds.play('move');
  }

  /** Re-render the current ply (used after a board flip moves the badges).
   *  A retry or puzzle run in progress is cancelled first — rendering over an
   *  unlocked retry board soft-locked the stepper. */
  rerender() {
    if (!this._analysis || !this._controller) return;
    if (this._retry || this._puzzleRun) {
      this._endRetry(false);
      this._puzzleRun = null;
    }
    this.renderStepperPly(this._viewPly);
  }

  toggleAutoplay() {
    if (!this._analysis || this._retry || this._puzzleRun) return;
    const btn = this._panel?.querySelector('[data-play]');
    if (this._autoplayTimer) {
      clearInterval(this._autoplayTimer);
      this._autoplayTimer = null;
      if (btn) btn.textContent = '▶';
      return;
    }
    if (btn) btn.textContent = '⏸';
    this._autoplayTimer = setInterval(() => {
      if (this._viewPly >= this._analysis.plies.length - 1) {
        clearInterval(this._autoplayTimer);
        this._autoplayTimer = null;
        if (btn) btn.textContent = '▶';
        return;
      }
      this.stepTo(this._viewPly + 1, true);
    }, 900);
  }

  renderStepperPly(plyIndex) {
    if (!this._analysis || !this._controller) return;
    const analysis = this._analysis;
    const total = analysis.plies.length;
    const ply = Math.max(-1, Math.min(total - 1, plyIndex));
    this._viewPly = ply;

    const ground = this._controller.ground;
    const beforeFen = analysis.fens[ply + 1];
    const position = analysis.positions[ply + 1];
    const move = ply >= 0 ? analysis.plies[ply] : null;

    let scratch;
    try {
      scratch = new Chess(beforeFen);
    } catch {
      return;
    }

    // The review board is always locked. The explicit movable reset matters
    // because chessground merges config — a finished retry must not leave
    // the board draggable (plan Hole 1).
    ground.set({
      fen: beforeFen,
      turnColor: scratch.turn() === 'w' ? 'white' : 'black',
      check: scratch.inCheck(),
      lastMove: move ? [move.from, move.to] : undefined,
      selectable: { enabled: false },
      movable: { free: false, color: false, dests: new Map() },
    });

    this._renderShapes(move);
    this._renderBadge(move);
    this._renderEvalBar(position);
    this._renderClocks(position, ply);
    this._renderCoach(move);
    this._highlightMoveList();
  }

  /** Replay-style clocks: show each side's remaining time AS IT WAS at the
   *  displayed position — frozen, never ticking. Active highlight marks the
   *  side that was to move. Games without a clock keep theirs hidden. */
  _renderClocks(position, ply) {
    const clock = position?.clock ?? null;
    if (!clock) return;
    const ui = this._controller.ui;
    ui.showClocks(true);
    const turn = ply >= 0
      ? this._analysis.plies[ply]?.turnAfter
      : this._analysis.positions[0]?.turn;
    const topColor = this._controller.orientation === 'white' ? 'b' : 'w';
    const bottomColor = topColor === 'w' ? 'b' : 'w';
    ui.setClock('top', ChessClock.formatTime(clock[topColor]), turn === topColor, clock[topColor] <= 20_000);
    ui.setClock('bottom', ChessClock.formatTime(clock[bottomColor]), turn === bottomColor, clock[bottomColor] <= 20_000);
  }

  _renderShapes(move) {
    const ground = this._controller.ground;
    if (!move) {
      ground.setAutoShapes([]);
      return;
    }
    const shapes = [];
    const isBad = BAD_TIERS.has(move.tier);
    // Green arrow: where the engine wanted the piece to go (plan §4.1 #2).
    if (move.bestMove && (isBad || move.bestSan !== move.san)) {
      shapes.push({ orig: move.bestMove.from, dest: move.bestMove.to, brush: 'green' });
    }
    // Red trail arrow on mistakes/ blunders: what was actually played.
    if (isBad) {
      shapes.push({ orig: move.from, dest: move.to, brush: 'red' });
      // Amber threat: the opponent's strongest punish (plan §4.1 #4).
      if (move.reply) {
        shapes.push({ orig: move.reply.from, dest: move.reply.to, brush: 'yellow' });
      }
    }
    ground.setAutoShapes(shapes);
  }

  _renderBadge(move) {
    const layer = this._badgeLayer;
    if (!layer) return;
    layer.innerHTML = '';
    if (!move) return;
    const tier = TIER_BY_KEY[move.tier];
    if (!tier) return;
    const badge = document.createElement('span');
    badge.className = `review-square-badge tier-${move.tier}`;
    if (move.tier === 'blunder') badge.classList.add('pulse');
    badge.textContent = tier.symbol;
    badge.style.color = tier.color;
    const [file, rank] = this._squareXY(move.to);
    badge.style.left = `${file * 12.5 + 6.25}%`;
    badge.style.top = `${rank * 12.5 + 6.25}%`;
    layer.appendChild(badge);
  }

  /** Square -> normalized column/row in CURRENT board orientation. */
  _squareXY(square) {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    let fileIdx = files.indexOf(square[0]);
    let rankIdx = Number(square[1]) - 1;
    if (this._controller.orientation === 'black') {
      fileIdx = 7 - fileIdx;
      rankIdx = 7 - rankIdx;
    }
    return [fileIdx, 7 - rankIdx];
  }

  _renderEvalBar(position) {
    const ui = this._controller.ui;
    const bar = document.getElementById('eval-bar');
    if (!bar) return;
    bar.classList.remove('hidden');
    const whitePct = Math.max(0, Math.min(100, position?.whiteWinProb ?? 50));
    const fill = bar.querySelector('[data-eval-fill]');
    fill.style.height = `${whitePct}%`;
    const label = bar.querySelector('[data-eval-label]');
    const cp = position?.whiteEvalCp ?? 0;
    label.textContent = Math.abs(cp) >= 10000 ? (cp > 0 ? 'M' : '-M') : (cp >= 0 ? '+' : '') + (cp / 100).toFixed(1);
  }

  hideEvalBar() {
    const bar = document.getElementById('eval-bar');
    bar?.classList.add('hidden');
  }

  _renderOverview() {
    const slot = this._panel?.querySelector('[data-overview]');
    if (!slot) return;
    const a = this._analysis;
    const acc = (v) => (v === null || v === undefined ? '—' : `${v}%`);
    slot.innerHTML = `
      <div class="review-acc-row">
        <span>ขาว ${escapeHtml(a.players.white?.name || '')} <b>${acc(a.accuracy.w)}</b></span>
        <span>ดำ ${escapeHtml(a.players.black?.name || '')} <b>${acc(a.accuracy.b)}</b></span>
      </div>
      ${a.opening ? `<div class="review-opening">📖 ${escapeHtml(a.opening.eco)} · ${escapeHtml(a.opening.name)}</div>` : ''}
    `;
  }

  _buildMoveList() {
    const list = this._panel?.querySelector('[data-movelist]');
    if (!list) return;
    list.innerHTML = '';
    const plies = this._analysis.plies;
    for (let i = 0; i < plies.length; i += 2) {
      const row = document.createElement('div');
      row.className = 'review-move-row';
      const num = document.createElement('span');
      num.className = 'review-move-num';
      num.textContent = `${Math.floor(i / 2) + 1}.`;
      row.appendChild(num);
      for (const j of [i, i + 1]) {
        if (j >= plies.length) break;
        const p = plies[j];
        const tier = TIER_BY_KEY[p.tier];
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = `review-move-cell tier-${p.tier}`;
        cell.dataset.ply = String(j);
        cell.innerHTML = `<span class="san">${escapeHtml(p.san)}</span><span class="sym" style="color:${tier.color}">${tier.symbol}</span>`;
        cell.onclick = () => this.stepTo(j, true);
        row.appendChild(cell);
      }
      list.appendChild(row);
    }
  }

  _highlightMoveList() {
    this._panel?.querySelectorAll('.review-move-cell').forEach((cell) => {
      cell.classList.toggle('active', Number(cell.dataset.ply) === this._viewPly);
    });
    const active = this._panel?.querySelector('.review-move-cell.active');
    active?.scrollIntoView({ block: 'nearest' });
  }

  _renderCoach(move) {
    const card = this._panel?.querySelector('[data-coach]');
    if (!card) return;
    if (!move) {
      card.innerHTML = `
        <div class="coach-empty">เริ่มรีวิวจากต้นเกม — กด <b>&gt;</b> หรือ <b>▶</b> เพื่อดูตาแรก<br/>(ปุ่มลูกศร ← → ใช้ได้ด้วย)</div>
      `;
      return;
    }
    const insight = this._coach.generateInsight(move);
    this._coach.speak(insight);
    const tier = TIER_BY_KEY[move.tier];
    const canRetry = RETRYABLE_TIERS.has(move.tier) && move.bestMove && !this._retry;
    // Foresight: the engine's predicted continuation AFTER the played move —
    // what the opponent can now do with the mistake (plan.md "คาดการณ์อนาคต").
    const forecast = BAD_TIERS.has(move.tier)
      ? (this._analysis.positions[move.ply + 1]?.pvSan ?? [])
      : [];
    card.innerHTML = `
      <div class="coach-head" style="color:${tier.color}">${tier.symbol} ${insight.headline}</div>
      <div class="coach-tag">${insight.tacticalTag} · เสียโอกาส ${move.deltaW}%</div>
      <div class="coach-compare">
        <span class="coach-played">คุณเดิน: <b>${escapeHtml(move.san)}</b></span>
        ${move.bestSan && move.bestSan !== move.san ? `<span class="coach-better">ตาที่ดีกว่า: <b>${escapeHtml(move.bestSan)}!</b></span>` : ''}
      </div>
      <p class="coach-explanation">${escapeHtml(insight.explanation)}</p>
      ${forecast.length ? `
        <div class="coach-forecast">
          <span class="coach-forecast-label">คาดการณ์อนาคต (เส้นทางที่เอนจินคำนวณ)</span>
          ${escapeHtml(forecast.join(' → '))}
        </div>` : ''}
      ${canRetry ? '<button class="btn primary coach-retry-btn" type="button">💡 ลองเดินแก้ตัว (Retry Mistake)</button>' : ''}
    `;
    card.querySelector('.coach-retry-btn')?.addEventListener('click', () => {
      this.startRetryMistake(move.ply);
    });
  }

  // ---- retry mistake simulation (plan §7.4, round 3) ----------------------
  // NOT a snap-back puzzle: a wrong move STAYS on the board, the engine
  // answers it visibly, and the user keeps playing to explore what would
  // have happened. One engine worker serves the whole simulated line.
  startRetryMistake(plyIndex, onResolved = null) {
    const ply = this._analysis?.plies[plyIndex];
    if (!ply?.bestMove || !this._controller) return;
    this.stopAutoplayIfRunning();
    this._stopSimLine();
    const beforeFen = this._analysis.fens[plyIndex];
    let scratch;
    try {
      scratch = new Chess(beforeFen);
    } catch {
      this._endRetry(false);
      return;
    }
    this._retry = {
      plyIndex,
      onResolved,
      ply,
      beforeFen,
      game: scratch,
      userColor: scratch.turn() === 'w' ? 'white' : 'black',
      judging: true,   // true while still at the original mistake ply
      phase: 'await-user',
      lastMove: null,
      token: {},       // identity token — stale engine callbacks bail on it
    };
    this._renderRetryCard('puzzle');
    this._setRetryBoard(beforeFen, null, this._retry.userColor);
  }

  /** Board config for one retry-sim state. movableColor=null locks the board
   *  (engine thinking / sim finished). */
  _setRetryBoard(fen, lastMove, movableColor) {
    if (!this._controller) return;
    let scratch;
    try {
      scratch = new Chess(fen);
    } catch {
      return;
    }
    let dests = null;
    if (movableColor) {
      dests = new Map();
      for (const m of scratch.moves({ verbose: true })) {
        if (!dests.has(m.from)) dests.set(m.from, []);
        dests.get(m.from).push(m.to);
      }
    }
    this._controller.ground.set({
      fen,
      lastMove: lastMove ?? undefined,
      turnColor: scratch.turn() === 'w' ? 'white' : 'black',
      check: scratch.inCheck(),
      selectable: { enabled: Boolean(movableColor) },
      movable: movableColor
        ? {
            free: false,
            color: movableColor,
            dests,
            events: {
              after: (orig, dest) => this._onRetryMove(orig, dest),
            },
          }
        : { free: false, color: false, dests: new Map() },
    });
  }

  async _onRetryMove(orig, dest) {
    const retry = this._retry;
    if (!retry || retry.phase !== 'await-user') return;
    const piece = retry.game.get(orig);
    const toRow = dest.charCodeAt(1) - 48;
    let promotion;
    if (piece?.type === 'p' && (toRow === 8 || toRow === 1)) {
      promotion = await this._controller.onPromotion(orig, dest);
      if (!promotion) {
        this._setRetryBoard(retry.game.fen(), retry.lastMove, retry.userColor);
        return;
      }
    }
    let move = null;
    try {
      move = retry.game.move({ from: orig, to: dest, promotion: promotion || undefined });
    } catch {
      move = null;
    }
    if (!move) {
      this._setRetryBoard(retry.game.fen(), retry.lastMove, retry.userColor);
      return;
    }
    sounds.play(move.captured ? 'capture' : 'move');
    if (
      retry.judging
      && retry.ply.bestMove.from === orig
      && retry.ply.bestMove.to === dest
      && (retry.ply.bestMove.promotion ?? 'q') === (promotion ?? 'q')
    ) {
      if (retry.run) {
        // Puzzle run: score it and move straight to the next puzzle.
        sounds.play('check');
        this._recordPuzzleResult(true);
        this._endRetry(true);
        this._nextPuzzle();
        return;
      }
      this._showRetrySolved(retry);
      return;
    }
    retry.judging = false;
    retry.phase = 'thinking';
    retry.lastMove = [orig, dest];
    // The wrong move STAYS on the board — the opponent now answers it visibly.
    this._setRetryBoard(retry.game.fen(), retry.lastMove, null);
    if (retry.game.isGameOver()) {
      retry.phase = 'over';
      if (retry.run) {
        // Wrong AND terminal: still a failed puzzle — reveal the solution.
        this._recordPuzzleResult(false);
        this._renderPuzzleCard('wrong', { reply: null });
        return;
      }
      this._renderRetryCard(retry.game.isCheckmate() ? 'sim-mate' : 'sim-draw');
      return;
    }
    if (retry.run) this._renderPuzzleCard('thinking');
    else this._renderRetryCard('thinking');
    this._ensureSimEngine();
  }

  /** Success is left ON the board (like the solution view) — the old code
   *  re-rendered the stepper straight over it, so the confirm never showed. */
  _showRetrySolved(retry) {
    sounds.play('check');
    const best = retry.ply.bestMove;
    let fenAfterBest = retry.beforeFen;
    try {
      const solved = new Chess(retry.beforeFen);
      solved.move({ from: best.from, to: best.to, promotion: best.promotion || undefined });
      fenAfterBest = solved.fen();
    } catch { /* keep pre-move view */ }
    this._setRetryBoard(fenAfterBest, [best.from, best.to], null);
    this._controller.ground.setAutoShapes([
      { orig: best.from, dest: best.to, brush: 'green' },
    ]);
    this._renderRetryCard('solved');
    this._endRetry(true);
  }

  /** One engine worker per retry session — searched once per simulated move. */
  _ensureSimEngine() {
    const retry = this._retry;
    if (!retry) return;
    const token = retry.token;
    if (this._forecastEngine) {
      this._runSimSearch(token);
      return;
    }
    let engine;
    engine = new Stockfish({
      // A stubbed worker can answer synchronously INSIDE the constructor —
      // before `this._forecastEngine = engine` runs — so onReady re-binds it.
      onReady: () => {
        if (!this._forecastEngine) this._forecastEngine = engine;
        if (this._retry?.token === token) this._runSimSearch(token);
      },
      onBestMove: (uci, info) => this._onSimBestMove(token, uci, info),
      onError: () => this._onSimEngineError(token),
    });
    if (!this._forecastEngine) this._forecastEngine = engine;
    this._runSimSearch(token);
  }

  _runSimSearch(token) {
    const retry = this._retry;
    if (!retry || retry.token !== token || !this._forecastEngine) return;
    // Not ready yet (real worker): onReady re-triggers this search.
    if (!this._forecastEngine.ready) return;
    this._forecastEngine.setPosition(retry.game.fen());
    this._forecastEngine.go({ depth: ANALYSIS_DEPTH });
  }

  _onSimBestMove(token, uci, info) {
    const retry = this._retry;
    if (!retry || retry.token !== token) return;
    this._renderSimEval(info?.score);
    let reply = null;
    if (uci) {
      try {
        reply = retry.game.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci.length > 4 ? uci[4] : undefined,
        });
      } catch {
        reply = null;
      }
    }
    if (!reply) {
      // A missing/illegal bestmove on a live position is an ENGINE fault —
      // never score it against the player (roadmap debug pass P1).
      retry.phase = 'sim-error';
      this._setRetryBoard(retry.game.fen(), retry.lastMove, null);
      if (retry.run) this._renderPuzzleCard('sim-error');
      else this._renderRetryCard('sim-error');
      return;
    }
    // A short beat so the user SEES their own move before the answer lands.
    this._simReplyTimer = setTimeout(() => {
      this._simReplyTimer = null;
      const r = this._retry;
      if (!r || r.token !== token) return;
      sounds.play(reply.captured ? 'capture' : 'move');
      const over = r.game.isGameOver();
      const runMode = Boolean(r.run);
      r.lastMove = [reply.from, reply.to];
      r.phase = over || runMode ? 'over' : 'await-user';
      this._setRetryBoard(r.game.fen(), r.lastMove, over || runMode ? null : r.userColor);
      if (runMode) {
        // Failed puzzle: reveal the solution, then the user advances.
        this._recordPuzzleResult(false);
        const restSans = Array.isArray(info?.pv) && info.pv.length > 1
          ? pvToSan(r.game.fen(), info.pv.slice(1))
          : [];
        this._renderPuzzleCard('wrong', { reply, restSans, score: info?.score });
        return;
      }
      if (over) {
        this._renderRetryCard(r.game.isCheckmate() ? 'sim-mate' : 'sim-draw');
        return;
      }
      const restSans = Array.isArray(info?.pv) && info.pv.length > 1
        ? pvToSan(r.game.fen(), info.pv.slice(1))
        : [];
      this._renderRetryCard('consequence', { reply, restSans, score: info?.score });
    }, RETRY_REPLY_DELAY_MS);
  }

  /** Live eval bar for the simulated position — score is side-to-move
   *  perspective (the opponent of the move just played). */
  _renderSimEval(score) {
    const retry = this._retry;
    if (!retry || !this._controller) return;
    let stmCp = null;
    if (typeof score === 'number') stmCp = Math.round(score * 100);
    else if (typeof score === 'string' && /^-?M\d+$/.test(score)) {
      stmCp = score.startsWith('-') ? -10000 : 10000;
    }
    if (stmCp === null) return;
    const white = retry.game.turn() === 'w';
    const probStm = convertCentipawnsToWinProbability(Math.max(-10000, Math.min(10000, stmCp)));
    this._renderEvalBar({
      whiteWinProb: Math.round(white ? probStm : 100 - probStm),
      whiteEvalCp: white ? stmCp : -stmCp,
    });
  }

  _renderRetryCard(phase, data = {}) {
    const card = this._panel?.querySelector('[data-coach]');
    const retry = this._retry;
    if (!card || !retry) return;
    const moverName = retry.userColor === 'white' ? 'ขาว' : 'ดำ';
    // Puzzle phase offers only the way out; the sim phases add restart/solution.
    const extraButtons = phase === 'sim-error'
      ? '<button class="btn primary" type="button" data-research>ลองคำนวณใหม่</button>'
      : '';
    const actions = `
      <div class="retry-actions">
        ${extraButtons}
        ${phase !== 'puzzle' ? '<button class="btn" type="button" data-restart>↺ เริ่มใหม่</button>' : ''}
        ${phase !== 'puzzle' ? '<button class="btn" type="button" data-solution>ดูเฉลย</button>' : ''}
        <button class="btn" type="button" data-cancel>กลับไปรีวิว</button>
      </div>`;
    const showActions = phase !== 'solved' && phase !== 'solution';
    let body = '';
    if (phase === 'puzzle') {
      body = `
        <div class="coach-head">💡 ลองเดินแก้ตัว</div>
        <p class="coach-explanation">กระดานอยู่ที่ตำแหน่งก่อนตาที่พลาด — ลากหมาก${moverName}หาตาที่ดีที่สุด
        เดินผิดแล้วฝ่ายตรงข้ามจะเดินตอบโต้ให้เห็นผลจริงบนกระดาน</p>`;
    } else if (phase === 'thinking') {
      body = `
        <div class="coach-head">💡 ลองเดินแก้ตัว</div>
        <div class="retry-status">⏳ ฝ่ายตรงข้ามกำลังคำนวณการตอบโต้…</div>`;
    } else if (phase === 'consequence') {
      const evalText = formatSimScore(data.score);
      const rest = data.restSans?.length
        ? `<div class="retry-line">คาดการณ์ต่อ: ${data.restSans.join(' → ')}</div>`
        : '';
      body = `
        <div class="coach-head">💡 ลองเดินแก้ตัว</div>
        <div class="retry-feedback">
          <b>ยังไม่ใช่ตาที่ดีที่สุด</b> — ฝ่ายตรงข้ามตอบ <b>${data.reply?.san ?? '?'}</b> ${evalText}
          ${rest}
          <div class="retry-hint">เดินต่อได้อีกเพื่อดูผล หรือกด เริ่มใหม่</div>
        </div>`;
    } else if (phase === 'sim-mate' || phase === 'sim-draw') {
      const winner = retry.game.turn() === 'w' ? 'ดำ' : 'ขาว';
      body = `
        <div class="coach-head">💡 ลองเดินแก้ตัว</div>
        <div class="retry-feedback">
          ${phase === 'sim-mate' ? `หมาจบ! ${winner}ชนะในการจำลอง` : 'จบเกมแบบเสมอในการจำลอง'}
          <div class="retry-hint">กด เริ่มใหม่ เพื่อลองตาอื่น หรือกลับไปรีวิว</div>
        </div>`;
    } else if (phase === 'sim-error') {
      body = `
        <div class="coach-head">💡 ลองเดินแก้ตัว</div>
        <div class="retry-status">⚠ ระบบวิเคราะห์ขัดข้องชั่วคราว — ผลครั้งนี้ไม่นับเป็นการเดินผิด</div>`;
    } else if (phase === 'solved') {
      body = `
        <div class="coach-head">💡 ลองเดินแก้ตัว</div>
        <div class="retry-feedback success">ถูกต้อง! นี่คือตาที่ดีที่สุด (${retry.ply.bestSan ?? '—'}) — กด ▶ หรือ → เพื่อดูต่อ</div>`;
    } else if (phase === 'solution') {
      body = `
        <div class="retry-feedback success">เฉลย: ${retry.ply.bestSan ?? '—'} — กด ▶ หรือ → เพื่อดูต่อ</div>`;
    }
    card.innerHTML = body + (showActions ? actions : '');
    card.querySelector('[data-research]')?.addEventListener('click', () => this._onSimResearch());
    card.querySelector('[data-restart]')?.addEventListener('click', () => {
      const r = this._retry;
      if (!r) return;
      this._stopSimLine();
      try {
        r.game.load(r.beforeFen);
      } catch {
        return;
      }
      r.judging = true;
      r.phase = 'await-user';
      r.lastMove = null;
      r.token = {};
      this._controller.ground.setAutoShapes([]);
      this._renderRetryCard('puzzle');
      this._setRetryBoard(r.beforeFen, null, r.userColor);
    });
    card.querySelector('[data-solution]')?.addEventListener('click', () => {
      const r = this._retry;
      if (!r) return;
      const best = r.ply.bestMove;
      let fenAfterBest = r.beforeFen;
      try {
        const solved = new Chess(r.beforeFen);
        solved.move({ from: best.from, to: best.to, promotion: best.promotion || undefined });
        fenAfterBest = solved.fen();
      } catch { /* keep current view */ }
      this._stopSimLine();
      this._setRetryBoard(fenAfterBest, [best.from, best.to], null);
      this._controller.ground.setAutoShapes([
        { orig: best.from, dest: best.to, brush: 'green' },
      ]);
      this._renderRetryCard('solution');
      this._endRetry(false);
    });
    card.querySelector('[data-cancel]')?.addEventListener('click', () => {
      const plyIndex = retry.plyIndex;
      this._endRetry(false);
      this.renderStepperPly(plyIndex);
    });
  }

  /** Engine worker crashed/ failed mid-simulation — a SYSTEM fault, never the
   *  player's: offer a re-search (and a no-penalty skip inside a puzzle run). */
  _onSimEngineError(token) {
    const retry = this._retry;
    if (!retry || retry.token !== token || retry.phase !== 'thinking') {
      this._quitForecastEngine();
      return;
    }
    retry.phase = 'sim-error';
    this._quitForecastEngine();
    if (retry.run) this._renderPuzzleCard('sim-error');
    else this._renderRetryCard('sim-error');
  }

  /** "ลองคำนวณใหม่" from a sim-error card — respawn the engine (if needed) and
   *  re-run the search on the same position. */
  _onSimResearch() {
    const retry = this._retry;
    if (!retry || retry.phase !== 'sim-error') return;
    retry.phase = 'thinking';
    if (retry.run) this._renderPuzzleCard('thinking');
    else this._renderRetryCard('thinking');
    this._ensureSimEngine();
  }

  _stopSimLine() {
    if (this._simReplyTimer) {
      clearTimeout(this._simReplyTimer);
      this._simReplyTimer = null;
    }
    this._quitForecastEngine();
  }

  // ---- puzzle run (roadmap.md A3) -----------------------------------------
  // A scored pass over every retryable ply: correct move = +1; wrong move = the
  // simulated opponent answers on the board, the solution is revealed, then the
  // run advances. One engine worker serves the whole run.
  startPuzzleRun() {
    if (!this._analysis || !this._controller) return;
    this.stopAutoplayIfRunning();
    this._stopSimLine();
    this._retry = null;
    const plies = this._analysis.plies
      .filter((p) => RETRYABLE_TIERS.has(p.tier) && p.bestMove)
      .map((p) => p.ply);
    if (!plies.length) return;
    this._puzzleRun = {
      plies,
      index: -1,
      score: 0,
      streak: 0,
      bestStreak: 0,
      results: [],
      lastPlyIndex: 0,
      storedBest: 0,
    };
    this._nextPuzzle();
  }

  _nextPuzzle() {
    const run = this._puzzleRun;
    if (!run) return;
    run.index += 1;
    if (run.index >= run.plies.length) {
      this._endPuzzleRun();
      return;
    }
    const plyIndex = run.plies[run.index];
    const ply = this._analysis?.plies[plyIndex];
    const beforeFen = this._analysis?.fens[plyIndex];
    let scratch;
    try {
      scratch = new Chess(beforeFen);
    } catch {
      this._recordPuzzleResult(false);
      this._nextPuzzle();
      return;
    }
    run.lastPlyIndex = plyIndex;
    this._retry = {
      plyIndex,
      onResolved: null,
      ply,
      beforeFen,
      game: scratch,
      userColor: scratch.turn() === 'w' ? 'white' : 'black',
      judging: true,
      phase: 'await-user',
      lastMove: null,
      token: {},
      run,
    };
    this._controller.ground.setAutoShapes([]);
    this._renderPuzzleCard('puzzle');
    this._setRetryBoard(beforeFen, null, this._retry.userColor);
  }

  _recordPuzzleResult(solved) {
    const run = this._puzzleRun;
    if (!run) return;
    if (solved) {
      run.score += 1;
      run.streak += 1;
      run.bestStreak = Math.max(run.bestStreak, run.streak);
    } else {
      run.streak = 0;
    }
    run.results.push({ ply: run.plies[run.index], solved });
  }

  _endPuzzleRun() {
    const run = this._puzzleRun;
    if (!run) return;
    this._stopSimLine();
    this._retry = null;
    run.done = true;
    try {
      const key = `chess-arena:puzzle-best:${this._analysis?.initialFen}#${this._analysis?.plies.length}`;
      const stored = Number(window.localStorage.getItem(key) ?? 0) || 0;
      run.storedBest = Math.max(stored, run.bestStreak);
      if (run.bestStreak > stored) window.localStorage.setItem(key, String(run.bestStreak));
    } catch {
      run.storedBest = run.bestStreak; // blocked storage — session value only
    }
    this._renderPuzzleCard('summary');
  }

  /** Card for the run: always a progress header, phase body, then actions. */
  _renderPuzzleCard(phase, data = {}) {
    const card = this._panel?.querySelector('[data-coach]');
    const run = this._puzzleRun;
    if (!card || !run) return;
    const total = run.plies.length;
    const retry = this._retry;
    const head = run.done
      ? '🏁 จบการฝึก!'
      : `🎯 ฝึกแก้ตาพลาด · ข้อ ${run.index + 1}/${total}`;
    const scoreLine = `คะแนน ${run.score} · สตรีค ${run.streak}`;
    let body = '';
    let actions = '';
    if (phase === 'puzzle') {
      const mover = retry?.userColor === 'white' ? 'ขาว' : 'ดำ';
      const tier = retry ? TIER_BY_KEY[retry.ply.tier] : null;
      const moveNo = Math.floor((retry?.plyIndex ?? 0) / 2) + 1;
      body = `
        <div class="coach-head">${head}</div>
        <div class="coach-tag">${scoreLine}</div>
        <p class="coach-explanation">ตาที่ ${moveNo} คุณเดิน ${retry?.ply.san ?? '?'}
        <span style="color:${tier?.color ?? 'inherit'}">${tier?.symbol ?? ''}</span>
        — ลากหมาก${mover}ลองหาตาที่ดีที่สุด</p>`;
      actions = `
        <div class="retry-actions">
          <button class="btn" type="button" data-skip>ข้ามข้อ</button>
          <button class="btn" type="button" data-finish>จบการฝึก</button>
        </div>`;
    } else if (phase === 'thinking') {
      body = `
        <div class="coach-head">${head}</div>
        <div class="coach-tag">${scoreLine}</div>
        <div class="retry-status">⏳ ฝ่ายตรงข้ามกำลังคำนวณการตอบโต้…</div>`;
      actions = `
        <div class="retry-actions">
          <button class="btn" type="button" data-finish>จบการฝึก</button>
        </div>`;
    } else if (phase === 'sim-error') {
      body = `
        <div class="coach-head">${head}</div>
        <div class="coach-tag">${scoreLine}</div>
        <div class="retry-status">⚠ ระบบวิเคราะห์ขัดข้องชั่วคราว — ผลครั้งนี้ไม่นับเป็นการเดินผิด</div>`;
      actions = `
        <div class="retry-actions">
          <button class="btn primary" type="button" data-research>ลองคำนวณใหม่</button>
          <button class="btn" type="button" data-skipclean>ข้ามข้อ (ไม่นับ)</button>
          <button class="btn" type="button" data-finish>จบการฝึก</button>
        </div>`;
    } else if (phase === 'wrong') {
      const evalText = formatSimScore(data.score);
      const answer = retry?.ply.bestSan ?? '?';
      const replyPart = data.reply ? ` ฝ่ายตรงข้ามตอบ <b>${data.reply.san}</b>${evalText}` : '';
      const rest = data.restSans?.length
        ? `<div class="retry-line">คาดการณ์ต่อ: ${data.restSans.join(' → ')}</div>`
        : '';
      body = `
        <div class="coach-head">${head}</div>
        <div class="coach-tag">${scoreLine}</div>
        <div class="retry-feedback">
          <b>ไม่ใช่ตาที่ดีที่สุด</b> — คำตอบคือ <b>${answer}</b>.${replyPart}
          ${rest}
          <div class="retry-hint">จำเส้นนี้ไว้ แล้วไปข้อถัดไป</div>
        </div>`;
      actions = `
        <div class="retry-actions">
          <button class="btn primary" type="button" data-next>ข้อถัดไป →</button>
          <button class="btn" type="button" data-finish>จบการฝึก</button>
        </div>`;
    } else if (phase === 'summary') {
      body = `
        <div class="coach-head">${head}</div>
        <div class="retry-feedback success">ได้ ${run.score}/${total} · สตรีคยาวสุด ${run.bestStreak}</div>
        <div class="retry-hint">สตรีคสูงสุดของเกมนี้: ${run.storedBest}</div>`;
      actions = `
        <div class="retry-actions">
          <button class="btn" type="button" data-run-restart>↺ เริ่มฝึกใหม่</button>
          <button class="btn" type="button" data-run-review>กลับไปรีวิว</button>
        </div>`;
    }
    card.innerHTML = body + actions;
    card.querySelector('[data-research]')?.addEventListener('click', () => this._onSimResearch());
    card.querySelector('[data-skipclean]')?.addEventListener('click', () => {
      // Engine-fault skip: advance WITHOUT recording a failure.
      this._endRetry(false);
      this._nextPuzzle();
    });
    card.querySelector('[data-skip]')?.addEventListener('click', () => {
      this._recordPuzzleResult(false);
      this._endRetry(false);
      this._nextPuzzle();
    });
    card.querySelector('[data-next]')?.addEventListener('click', () => this._nextPuzzle());
    card.querySelector('[data-finish]')?.addEventListener('click', () => this._endPuzzleRun());
    card.querySelector('[data-run-restart]')?.addEventListener('click', () => this.startPuzzleRun());
    card.querySelector('[data-run-review]')?.addEventListener('click', () => {
      const lastPlyIndex = run.lastPlyIndex ?? 0;
      this._puzzleRun = null;
      this.renderStepperPly(lastPlyIndex);
    });
  }

  _quitForecastEngine() {
    if (this._forecastEngine) {
      this._forecastEngine.quit();
      this._forecastEngine = null;
    }
  }

  stopAutoplayIfRunning() {
    if (this._autoplayTimer) {
      clearInterval(this._autoplayTimer);
      this._autoplayTimer = null;
      const btn = this._panel?.querySelector('[data-play]');
      if (btn) btn.textContent = '▶';
    }
  }

  _endRetry(resolved) {
    this._stopSimLine();
    const { onResolved } = this._retry ?? {};
    this._retry = null;
    // Hand the board back to review lock state (renderStepperPly re-locks).
    onResolved?.(resolved);
  }
}
