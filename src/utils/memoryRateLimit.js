/**
 * Small fixed-window rate limiter kept in process memory.
 * Good enough for a single instance; with several instances each keeps its own counters
 * (move to Redis if you scale horizontally).
 */
const MAX_TRACKED_KEYS = 50000;

function createMemoryRateLimiter({ windowMs, max }) {
  const hits = new Map();
  let lastSweep = Date.now();

  function sweep(now) {
    if (now - lastSweep < windowMs && hits.size < MAX_TRACKED_KEYS) return;
    lastSweep = now;
    for (const [key, record] of hits) {
      if (now - record.start >= windowMs) hits.delete(key);
    }
    if (hits.size >= MAX_TRACKED_KEYS) hits.clear();
  }

  return {
    check(key) {
      const now = Date.now();
      sweep(now);
      const record = hits.get(key);
      if (!record || now - record.start >= windowMs) {
        hits.set(key, { start: now, count: 1 });
        return { allowed: true, remaining: max - 1, retryAfterMs: 0 };
      }
      if (record.count >= max) {
        return { allowed: false, remaining: 0, retryAfterMs: windowMs - (now - record.start) };
      }
      record.count += 1;
      return { allowed: true, remaining: max - record.count, retryAfterMs: 0 };
    },
    reset() {
      hits.clear();
    },
  };
}

module.exports = { createMemoryRateLimiter };
