export const TIME_CONTROLS = Object.freeze({
  unlimited: null,
  bullet_1_0: { initialMs: 60_000, incrementMs: 0 },
  bullet_1_1: { initialMs: 60_000, incrementMs: 1_000 },
  blitz_3_1_5: { initialMs: 180_000, incrementMs: 1_500 },
  blitz_5_0: { initialMs: 300_000, incrementMs: 0 },
  rapid_10_0: { initialMs: 600_000, incrementMs: 0 },
  rapid_15_0: { initialMs: 900_000, incrementMs: 0 },
  classical_30_0: { initialMs: 1_800_000, incrementMs: 0 },
});

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SQUARE_PATTERN = /^[a-h][1-8]$/u;

const invalid = (message = 'ข้อมูลคำขอไม่ถูกต้อง') => ({
  ok: false,
  code: 'invalid_request',
  message,
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function boundedText(value, max, { required = true } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  const size = Array.from(normalized).length;
  if ((required && size === 0) || size > max) return null;
  return normalized;
}

export function parseCreateRequest(value) {
  const allowed = ['playerName', 'title', 'color', 'timeControlId', 'initialFen'];
  if (!isRecord(value) || !hasOnlyKeys(value, allowed)) return invalid();

  const playerName = boundedText(value.playerName, 40);
  const title = boundedText(value.title ?? 'ห้องประลองออนไลน์', 80);
  const initialFen = boundedText(value.initialFen, 128, { required: false });
  const color = value.color ?? 'random';
  const timeControlId = value.timeControlId ?? 'unlimited';

  if (playerName === null || title === null || initialFen === null) return invalid();
  if (!['w', 'b', 'random'].includes(color)) return invalid('สีที่เลือกไม่ถูกต้อง');
  if (!Object.hasOwn(TIME_CONTROLS, timeControlId)) return invalid('รูปแบบเวลาไม่ถูกต้อง');

  return {
    ok: true,
    value: { playerName, title, color, timeControlId, initialFen },
  };
}

export function parseJoinRequest(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, ['playerName', 'inviteToken'])) return invalid();
  const playerName = boundedText(value.playerName, 40);
  if (playerName === null || typeof value.inviteToken !== 'string' || !CAPABILITY_PATTERN.test(value.inviteToken)) {
    return invalid();
  }
  return { ok: true, value: { playerName, inviteToken: value.inviteToken } };
}

export function parseSocketCommand(input) {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      return invalid('ข้อความไม่ใช่ JSON ที่ถูกต้อง');
    }
  }
  if (!isRecord(value) || typeof value.type !== 'string') return invalid();

  if (value.type === 'sync' || value.type === 'ping') {
    if (!hasOnlyKeys(value, ['type'])) return invalid();
    return { ok: true, value: { type: value.type } };
  }

  if (value.type === 'resign') {
    if (!hasOnlyKeys(value, ['type', 'expectedRevision'])) return invalid();
    if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) return invalid();
    return { ok: true, value: { type: 'resign', expectedRevision: value.expectedRevision } };
  }

  if (value.type === 'move') {
    if (!hasOnlyKeys(value, ['type', 'from', 'to', 'promotion', 'expectedRevision'])) return invalid();
    if (!SQUARE_PATTERN.test(value.from) || !SQUARE_PATTERN.test(value.to)) return invalid('ช่องเดินไม่ถูกต้อง');
    if (value.promotion !== undefined && !['q', 'r', 'b', 'n'].includes(value.promotion)) {
      return invalid('ตัวโปรโมตไม่ถูกต้อง');
    }
    if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) return invalid();
    return {
      ok: true,
      value: {
        type: 'move',
        from: value.from,
        to: value.to,
        ...(value.promotion === undefined ? {} : { promotion: value.promotion }),
        expectedRevision: value.expectedRevision,
      },
    };
  }

  return invalid('ไม่รู้จักคำสั่งนี้');
}
