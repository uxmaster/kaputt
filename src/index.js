import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRuntime, integer, parseNonce, seedFor, U64_MAX, validSpec } from './hashwx.js';

/** @typedef {{c: string, d: number, n: number}} Puzzle */
/** @typedef {(key: string, ttlMs: number) => Promise<boolean>} ConsumeNonce
 * Atomically store a key only if absent, for at least ttlMs. Return true only for the first caller.
 */
/** @typedef {{scope?: string, consumeNonce: ConsumeNonce, tokenTtlMs?: number}} ValidationOptions */

const MAX_TTL = 86_400_000;
let runtime;
async function ready() {
  runtime ??= readFile(new URL('./hashwx.wasm', import.meta.url))
    .then(bytes => WebAssembly.compile(bytes)).then(module => createRuntime(module))
    .catch(error => { runtime = undefined; throw error; });
  return runtime;
}

/** @param {string|Uint8Array} secret */
function checkSecret(secret) {
  if (!(typeof secret === 'string' || secret instanceof Uint8Array) || Buffer.byteLength(secret) < 32)
    throw new TypeError('Use a random secret of at least 32 bytes');
}
function checkScope(scope) {
  if (typeof scope !== 'string' || scope.length > 256) throw new TypeError('scope must be a string of at most 256 characters');
}
function ttl(value) {
  if (!integer(value, 1, MAX_TTL)) throw new TypeError('TTL must be an integer from 1 to 86400000 ms');
  return value;
}
function sign(secret, data) {
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`kaputt.v1.${body}`).digest('base64url');
  return `${body}.${signature}`;
}
function open(secret, token, purpose, scope) {
  if (typeof token !== 'string' || token.length > 16384) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
  const expected = createHmac('sha256', secret).update(`kaputt.v1.${parts[0]}`).digest();
  const actual = Buffer.from(parts[1], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (data?.v !== 1 || data.purpose !== purpose || data.scope !== scope ||
      !/^[0-9a-f]{32}$/.test(data.id) || !Number.isSafeInteger(data.expires)) return null;
    return data;
  } catch { return null; }
}
const fail = reason => ({ success: false, reason });
function optionsCheck(options) {
  checkScope(options.scope ?? '');
  if (typeof options.consumeNonce !== 'function') throw new TypeError('An atomic consumeNonce callback is required');
}
async function consume(options, data) {
  const remaining = data.expires - Date.now();
  if (remaining <= 0) return fail('expired');
  try {
    const stored = await options.consumeNonce(`kaputt:${data.purpose}:${data.id}`, remaining);
    if (stored !== true) return fail('already_used');
    if (data.expires <= Date.now()) return fail('expired');
    return null;
  } catch { return fail('storage_error'); }
}

/** Issue signed, stateless HashWX puzzles. Keep the secret on the server.
 * @param {string|Uint8Array} secret
 * @param {{scope?: string, expiresMs?: number, difficulty?: number, count?: number, noncesPerHash?: number}} [options]
 * @returns {{token: string, challenges: Puzzle[], expires: number}}
 */
export function generateChallenge(secret, options = {}) {
  checkSecret(secret);
  const { scope = '', difficulty = 1_000_000, count = 4, noncesPerHash = 65536 } = options;
  checkScope(scope);
  if (!integer(difficulty, 1, 1_000_000_000) || !integer(count, 1, 64) || !integer(noncesPerHash, 1, 1_048_576))
    throw new TypeError('Invalid HashWX difficulty, count or noncesPerHash');
  const challenges = Array.from({ length: count }, () => ({
    c: randomBytes(32).toString('hex'), d: Math.max(1, Math.round(difficulty / count)), n: noncesPerHash,
  }));
  const expires = Date.now() + ttl(options.expiresMs ?? 600_000);
  const token = sign(secret, { v: 1, purpose: 'challenge', id: randomBytes(16).toString('hex'), scope, expires, challenges });
  return { token, challenges, expires };
}

/** Verify work against signed parameters, consume the challenge once, and issue a scoped token.
 * @param {string|Uint8Array} secret
 * @param {unknown} body Untrusted JSON: {token, solutions: [{nonce: decimalString}]}.
 * @param {ValidationOptions} options
 * @returns {Promise<{success: boolean, reason?: string, token?: string, expires?: number}>}
 */
export async function validateChallenge(secret, body, options) {
  checkSecret(secret);
  optionsCheck(options);
  const tokenTtl = ttl(options.tokenTtlMs ?? 1_200_000);
  if (!body || typeof body !== 'object') return fail('invalid_body');
  const data = open(secret, body.token, 'challenge', options.scope ?? '');
  if (!data) return fail('invalid_token');
  if (data.expires <= Date.now()) return fail('expired');
  if (!Array.isArray(data.challenges) || !integer(data.challenges.length, 1, 64) || !data.challenges.every(validSpec)) return fail('invalid_token');
  if (!Array.isArray(body.solutions) || body.solutions.length !== data.challenges.length) return fail('invalid_solutions');
  const nonces = body.solutions.map(solution => parseNonce(solution?.nonce));
  if (nonces.includes(null)) return fail('invalid_solutions');
  const state = await ready();
  for (let i = 0; i < nonces.length; i++) {
    const spec = data.challenges[i];
    const seed = await seedFor(spec.c, nonces[i] / BigInt(spec.n));
    // No await between make and hash: concurrent requests share this interpreter safely.
    state.make(seed);
    if (state.hash(nonces[i]) > U64_MAX / BigInt(spec.d)) return fail('invalid_solution');
  }
  const failure = await consume(options, data);
  if (failure) return failure;
  const expires = Date.now() + tokenTtl;
  return { success: true, expires, token: sign(secret, {
    v: 1, purpose: 'access', id: randomBytes(16).toString('hex'), scope: data.scope, expires,
  }) };
}

/** Consume an access token at your protected action. A token grants one action, in one scope.
 * @param {string|Uint8Array} secret @param {unknown} token
 * @param {ValidationOptions} options
 * @returns {Promise<{success: boolean, reason?: string}>}
 */
export async function validateToken(secret, token, options) {
  checkSecret(secret);
  optionsCheck(options);
  const data = open(secret, token, 'access', options.scope ?? '');
  if (!data) return fail('invalid_token');
  return await consume(options, data) ?? { success: true };
}
