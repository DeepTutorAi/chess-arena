// Motif coach (roadmap B3): turns "you lost 24%" into a reason a player can act
// on — "your rook on a1 was left undefended", "this lets a knight fork your queen
// and rook". Pure functions over chess.js positions; no engine, no DOM.
//
// The detectors are deliberately conservative: a reason is only reported when the
// board really shows it (an actual capture, an actual double attack, a real mate),
// otherwise the coach keeps its generic text. Wrong advice is worse than none.

import { Chess } from 'chess.js';

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
// For "can this piece be taken cheaply" the king counts as very valuable to lose
// but is never a cheap capturer of a defended piece.
const ATTACKER_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const NAME = { p: 'เบี้ย', n: 'ม้า', b: 'บิชอป', r: 'เรือ', q: 'ควีน', k: 'คิง' };

const other = (color) => (color === 'w' ? 'b' : 'w');
const label = (piece, square) => `${NAME[piece.type]}ที่ ${square}`;
// Thai has no spaces between words, but a square name (Latin letters) must be
// set off from the Thai text around it.
const join = (items) => items.map((t) => label({ type: t.type }, t.square)).join(' และ ');

function load(fen) {
  try { return new Chess(fen); } catch { return null; }
}

function play(game, move) {
  if (!game || !move) return null;
  try {
    return game.move({ from: move.from, to: move.to, promotion: move.promotion || undefined });
  } catch {
    return null;
  }
}

const squaresOf = (game, color) => game.board().flat().filter((p) => p && p.color === color);

/**
 * Pieces of the side opposite to `forkerColor` that the piece on `forkerSquare`
 * attacks and that would really be lost or checked: the king (a check), a piece
 * worth more than the forker, or an undefended piece worth at least a minor.
 * Empty when the forker could simply be captured first.
 */
export function forkTargets(game, forkerSquare) {
  const forker = game.get(forkerSquare);
  if (!forker || forker.type === 'k') return [];
  const victimColor = other(forker.color);

  // A forking piece that can be taken for free (or by something cheaper) is no fork.
  const hunters = game.attackers(forkerSquare, victimColor);
  if (hunters.length) {
    const cheapest = Math.min(...hunters.map((sq) => ATTACKER_VALUE[game.get(sq).type]));
    const defended = game.attackers(forkerSquare, forker.color).length > 0;
    if (!defended || cheapest < VALUE[forker.type]) return [];
  }

  const targets = [];
  for (const piece of squaresOf(game, victimColor)) {
    if (!game.attackers(piece.square, forker.color).includes(forkerSquare)) continue;
    const value = VALUE[piece.type];
    const undefended = game.attackers(piece.square, victimColor).length === 0;
    if (piece.type === 'k' || value > VALUE[forker.type] || (undefended && value >= 3)) {
      targets.push({ square: piece.square, type: piece.type });
    }
  }
  return targets;
}

/** A checkmate delivered along the back rank against a king boxed in by its own pawns. */
export function isBackRankMate(game) {
  if (!game.isCheckmate()) return false;
  const loser = game.turn();
  const king = squaresOf(game, loser).find((p) => p.type === 'k');
  if (!king) return false;
  const backRank = loser === 'w' ? '1' : '8';
  if (king.square[1] !== backRank) return false;
  const file = king.square.charCodeAt(0);
  const forward = loser === 'w' ? Number(backRank) + 1 : Number(backRank) - 1;
  for (const df of [-1, 0, 1]) {
    const sq = `${String.fromCharCode(file + df)}${forward}`;
    if (!/^[a-h][1-8]$/.test(sq)) continue;
    const occupant = game.get(sq);
    if (!occupant || occupant.color !== loser) return false; // an escape square exists
  }
  // The mating piece must be a rook or queen giving the check along the rank.
  return game.attackers(king.square, other(loser)).some((sq) => {
    const piece = game.get(sq);
    return (piece.type === 'r' || piece.type === 'q') && sq[1] === king.square[1];
  });
}

/**
 * Why a move cost so much. Returns the most useful reasons first (at most two).
 * @param {object} ctx
 * @param {string} ctx.fenBefore                position the move was played from
 * @param {{from: string, to: string, promotion?: string}} ctx.played
 * @param {{from: string, to: string, promotion?: string}|null} [ctx.best]    engine's choice there
 * @param {{from: string, to: string, promotion?: string}|null} [ctx.reply]   engine's best answer to the played move
 * @param {number|null} [ctx.bestMate]          mover's forced mate in N (>0) in the position before
 * @param {number|null} [ctx.afterMate]         mate for the mover after the move (<0 means mover gets mated)
 * @returns {{key: string, text: string}[]}
 */
export function explainMistake({ fenBefore, played, best = null, reply = null, bestMate = null, afterMate = null }) {
  try {
    const before = load(fenBefore);
    if (!before) return [];
    const mover = before.turn();
    const bestGame = best ? load(fenBefore) : null;
    const bestMove = play(bestGame, best);
    const afterPlay = load(fenBefore);
    const playedMove = play(afterPlay, played);
    if (!playedMove) return [];
    const reasons = [];

    // 1. A forced mate was on the board.
    if (bestMate !== null && bestMate > 0 && bestMove) {
      reasons.push({
        key: 'missed-mate',
        text: `พลาดรุกฆาตบังคับใน ${bestMate} ตา — ตา ${bestMove.san} ทำให้ฝ่ายตรงข้ามไม่มีทางรอด`,
      });
    }

    // 2. The move lets the opponent mate.
    const afterReply = reply ? load(afterPlay.fen()) : null;
    const replyMove = play(afterReply, reply);
    if (replyMove && afterReply.isCheckmate()) {
      reasons.push({
        key: 'allowed-mate',
        text: isBackRankMate(afterReply)
          ? 'ตานี้ทำให้ถูกรุกฆาตแถวหลัง (back-rank mate) ทันที — คิงถูกเบี้ยของตัวเองขวางทางหนี'
          : 'ตานี้ทำให้ฝ่ายตรงข้ามรุกฆาตได้ทันที',
      });
    } else if (afterMate !== null && afterMate < 0) {
      reasons.push({ key: 'allowed-mate', text: `ตานี้เปิดทางให้ฝ่ายตรงข้ามรุกฆาตบังคับใน ${-afterMate} ตา` });
    }

    // 3. What the opponent's best answer wins. (A recapture on the square our own
    //    capture landed on is an exchange, judged in step 4, not a hung piece.)
    const recapture = Boolean(playedMove.captured && replyMove && replyMove.to === playedMove.to);
    if (replyMove && !afterReply.isCheckmate()) {
      const forks = forkTargets(afterReply, replyMove.to);
      if (forks.length >= 2) {
        const forker = afterReply.get(replyMove.to);
        reasons.push({
          key: 'allowed-fork',
          text: `เปิดทางให้${NAME[forker.type]}แฉก (fork) — ${replyMove.san} โจมตี ${join(forks)} พร้อมกัน`,
        });
      } else if (replyMove.captured && !recapture) {
        const victim = { type: replyMove.captured };
        const defenders = afterPlay.attackers(replyMove.to, mover).length;
        const capturer = ATTACKER_VALUE[replyMove.piece];
        const free = defenders === 0;
        const badTrade = !free && VALUE[victim.type] > Math.min(capturer, 9) + 0.5 && capturer < 100;
        if (VALUE[victim.type] >= 1 && (free || badTrade)) {
          const wasMovedPiece = replyMove.to === playedMove.to;
          reasons.push({
            key: free ? 'hanging' : 'bad-exchange',
            text: free
              ? (wasMovedPiece
                ? `${label(victim, replyMove.to)} ที่เพิ่งเดินไปไม่มีหมากคุ้มกัน จึงถูก ${replyMove.san} กินฟรี`
                : `ปล่อยให้${label(victim, replyMove.to)} ไม่มีหมากคุ้มกัน — ถูก ${replyMove.san} กินฟรี`)
              : `${label(victim, replyMove.to)} ถูก${NAME[replyMove.piece]}กิน (${replyMove.san}) เป็นการแลกที่เสียเปรียบ`,
          });
        }
      }
    }

    // 4. The move itself: a capture that costs more than it wins.
    if (playedMove.captured && replyMove?.to === playedMove.to && replyMove.captured) {
      const won = VALUE[playedMove.captured];
      const lost = VALUE[replyMove.captured];
      if (lost > won + 1) {
        reasons.push({
          key: 'bad-capture',
          text: `กิน${NAME[playedMove.captured]}ได้ แต่เสีย${NAME[replyMove.captured]}ที่กินไปกลับมา — แลกไม่คุ้ม (${playedMove.san} → ${replyMove.san})`,
        });
      }
    }

    // 5. What the better move offered.
    if (bestMove) {
      const bestVictim = bestMove.captured;
      const playedWon = playedMove.captured ? VALUE[playedMove.captured] : 0;
      if (bestVictim && VALUE[bestVictim] >= 3 && VALUE[bestVictim] > playedWon) {
        const free = before.attackers(bestMove.to, other(mover)).length === 0;
        reasons.push({
          key: 'missed-capture',
          text: `พลาดโอกาสกิน${label({ type: bestVictim }, bestMove.to)} ${free ? 'ที่ไม่มีใครคุ้มกัน ' : ''}ด้วย ${bestMove.san}`,
        });
      } else {
        const afterBest = load(bestGame.fen());
        const targets = afterBest ? forkTargets(afterBest, bestMove.to) : [];
        if (targets.length >= 2) {
          const forker = afterBest.get(bestMove.to);
          reasons.push({
            key: 'missed-fork',
            text: `พลาดโอกาสแฉก (fork) — ${bestMove.san} ของ${NAME[forker.type]}โจมตี ${join(targets)} พร้อมกัน`,
          });
        } else if (bestMove.promotion && !playedMove.promotion) {
          reasons.push({ key: 'missed-promotion', text: `พลาดโอกาสเลื่อนขั้นเบี้ยด้วย ${bestMove.san}` });
        } else if (bestMove.san.includes('+') && !playedMove.san.includes('+') && playedWon === 0 && reasons.length === 0) {
          reasons.push({ key: 'missed-check', text: `ตา ${bestMove.san} เป็นการรุกที่ได้เปรียบมากกว่า` });
        }
      }
    }

    return reasons.slice(0, 2);
  } catch {
    return [];
  }
}

/**
 * Why a strong move was strong — only notable things (mate, free material, a
 * working fork, a sacrifice). Empty for quiet moves.
 */
export function explainGoodMove({ fenBefore, played, reply = null }) {
  try {
    const game = load(fenBefore);
    const move = play(game, played);
    if (!move) return [];
    const mover = move.color;
    const reasons = [];

    if (game.isCheckmate()) {
      reasons.push({
        key: 'mate',
        text: isBackRankMate(game) ? 'รุกฆาตแถวหลัง — จบเกมด้วยตานี้' : 'รุกฆาต — จบเกมด้วยตานี้',
      });
      return reasons;
    }

    const targets = forkTargets(game, move.to);
    if (targets.length >= 2) {
      reasons.push({ key: 'fork', text: `แฉก (fork) — ${move.san} โจมตี ${join(targets)} พร้อมกัน` });
    }

    if (move.captured && VALUE[move.captured] >= 1) {
      // Was the capture safe? Look at the opponent's best answer when we have it.
      const recaptured = reply && reply.to === move.to;
      const defended = game.attackers(move.to, other(mover)).length > 0;
      if (!recaptured && !defended && VALUE[move.captured] >= 3) {
        reasons.push({ key: 'free-piece', text: `กิน${NAME[move.captured]}ได้ฟรี — ไม่มีหมากของฝ่ายตรงข้ามคุ้มกันอยู่` });
      } else if (VALUE[move.captured] > ATTACKER_VALUE[move.piece] + 0.5) {
        reasons.push({ key: 'good-capture', text: `ใช้${NAME[move.piece]}กิน${NAME[move.captured]} — ได้วัสดุมากกว่าที่เสีย` });
      }
    }

    if (move.promotion) reasons.push({ key: 'promotion', text: 'เลื่อนขั้นเบี้ยเป็นหมากที่แข็งแกร่งขึ้น' });
    return reasons.slice(0, 2);
  } catch {
    return [];
  }
}
