// In-isolate sliding-window limiter for the room-creation endpoint.
// Creating a room spawns a Durable Object, storage writes and a lobby upsert
// in one unauthenticated call — the cheapest abuse primitive on this worker —
// so it is throttled per client IP before any of that happens.
//
// State lives in module scope: every isolate enforces its own window. That is
// approximate across isolates by design — it blunts floods without adding a
// network hop to every create. CF-Connecting-IP is injected by the Cloudflare
// edge; the entry worker skips throttling when it is absent (local dev/tests).

const WINDOW_MS = 60_000;
const MAX_CREATES_PER_WINDOW = 30;
// Hard bound on tracked IPs so one long-lived isolate cannot grow memory
// without limit; eviction is insertion-ordered (oldest key first).
const MAX_TRACKED_IPS = 10_000;

export function consumeCreateAttempt(attempts, key, now, {
  windowMs = WINDOW_MS,
  max = MAX_CREATES_PER_WINDOW,
  maxTrackedKeys = MAX_TRACKED_IPS,
} = {}) {
  const recent = (attempts.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
  if (recent.length >= max) {
    attempts.set(key, recent);
    return false;
  }
  recent.push(now);
  attempts.set(key, recent);
  while (attempts.size > maxTrackedKeys) {
    const oldest = attempts.keys().next().value;
    attempts.delete(oldest);
  }
  return true;
}
