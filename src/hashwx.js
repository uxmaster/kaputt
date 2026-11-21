// Adapted from Cap's HashWX integration; see NOTICE.
export const U64_MAX = (1n << 64n) - 1n;

/** @param {unknown} value @param {number} min @param {number} max */
export function integer(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/** @param {unknown} spec */
export function validSpec(spec) {
  return !!spec && typeof spec === 'object' &&
    typeof spec.c === 'string' && /^[0-9a-f]{64}$/.test(spec.c) &&
    integer(spec.d, 1, 1_000_000_000) && integer(spec.n, 1, 1_048_576);
}

/** @param {unknown} value @returns {bigint|null} */
export function parseNonce(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return null;
  const n = BigInt(value);
  return n <= U64_MAX ? n : null;
}
