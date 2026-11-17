/** Single-process example. Every instance must share the same store in production. */
const used = new Map();

/** Atomically accept each key once until its expiry. @param {string} key @param {number} ttlMs */
export async function consumeNonce(key, ttlMs) {
  const now = Date.now();
  // Remove expired entries even when subsequent requests use different keys.
  for (const [id, expires] of used) if (expires <= now) used.delete(id);
  if (used.has(key)) return false;
  used.set(key, now + ttlMs);
  return true;
}
