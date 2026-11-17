import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateChallenge, validateChallenge, validateToken } from '../src/index.js';
import { createRuntime, parseNonce, seedFor, U64_MAX } from '../src/hashwx.js';
import { consumeNonce } from '../examples/memory.js';

const secret = 'test-secret-with-at-least-32-bytes';
const wasm = await Bun.file(new URL('../src/hashwx.wasm', import.meta.url)).bytes();
const module = await WebAssembly.compile(wasm);
const opts = { scope: 'signup', consumeNonce };
async function solve(challenge) {
  const state = createRuntime(module);
  try {
    const solutions = [];
    for (const spec of challenge.challenges) {
      for (let nonce = 0n; ; nonce++) {
        if (nonce % BigInt(spec.n) === 0n) state.make(await seedFor(spec.c, nonce / BigInt(spec.n)));
        if (state.hash(nonce) <= U64_MAX / BigInt(spec.d)) { solutions.push({ nonce: String(nonce) }); break; }
      }
    }
    return { token: challenge.token, solutions };
  } finally { state.free(); }
}

test('HashWX binary, seed derivation and compiled/interpreted implementations agree', async () => {
  assert.equal(createHash('sha256').update(wasm).digest('hex'), 'b1a0dbb3ef444d3c7069e0a5e0a0273ffa4cf8fef62cbbe43761c02f7cd6aff5');
  const seed = await seedFor('00'.repeat(32), 7n);
  const bytes = Buffer.alloc(40); bytes.writeBigUInt64LE(7n, 32);
  assert.deepEqual(Buffer.from(seed), createHash('sha256').update(bytes).digest());
  const interpreted = createRuntime(module), compiled = createRuntime(module, true);
  try {
    interpreted.make(seed); compiled.make(seed);
    // Fixed outputs from Cap's original implementation for this seed.
    const vectors = [[0n, 7336585210112456398n], [1n, 14769033470795751765n],
      [65537n, 14580528726182167658n], [U64_MAX, 12950432543790437361n]];
    for (const [nonce, expected] of vectors) {
      assert.equal(interpreted.hash(nonce), expected);
      assert.equal(compiled.hash(nonce), expected);
    }
  } finally { interpreted.free(); compiled.free(); }
});

test('compiled runtime falls back to an interpreter when generated WASM is blocked', async () => {
  const state = createRuntime(module, true);
  const reference = createRuntime(module);
  const original = WebAssembly.Module;
  const seed = await seedFor('12'.repeat(32), 0n);
  try {
    WebAssembly.Module = function () { throw new Error('CSP'); };
    state.make(seed); reference.make(seed);
    assert.equal(state.hash(8n), reference.hash(8n));
  } finally { WebAssembly.Module = original; state.free(); reference.free(); }
});

test('generate, solve, redeem and consume access token once, under concurrency', async () => {
  const challenge = generateChallenge(secret, { difficulty: 64, count: 4, noncesPerHash: 16, scope: 'signup' });
  assert.equal(challenge.ttlMs, 600_000);
  const proof = await solve(challenge);
  const results = await Promise.all(Array.from({ length: 6 }, () => validateChallenge(secret, proof, opts)));
  assert.equal(results.filter(r => r.success).length, 1);
  const result = results.find(r => r.success);
  assert.equal(result.ttlMs, 1_200_000);
  assert.equal((await validateToken(secret, result.token, { ...opts, scope: 'login' })).success, false);
  assert.equal((await validateChallenge(secret, { token: result.token, solutions: [] }, opts)).success, false);
  assert.equal((await validateToken(secret, proof.token, opts)).success, false);
  const actions = await Promise.all(Array.from({ length: 6 }, () => validateToken(secret, result.token, opts)));
  assert.equal(actions.filter(r => r.success).length, 1);
});

test('reject tampering, malformed bodies, nonces and wrong scopes without consuming valid work', async () => {
  const challenge = generateChallenge(secret, { difficulty: 32, count: 1, scope: 'signup' });
  const proof = await solve(challenge);
  const changed = { ...proof, token: `${proof.token[0] === 'A' ? 'B' : 'A'}${proof.token.slice(1)}` };
  assert.equal((await validateChallenge(secret, changed, opts)).reason, 'invalid_token');
  assert.equal((await validateChallenge(secret, proof, { ...opts, scope: '' })).reason, 'invalid_token');
  for (const body of [null, [], {}, { token: proof.token, solutions: [] }, { ...proof, solutions: [{ nonce: '-1' }] }])
    assert.equal((await validateChallenge(secret, body, opts)).success, false);
  for (const nonce of [-1, 0, null, {}, '-1', '1e3', '01', '18446744073709551616', '9'.repeat(1000)]) assert.equal(parseNonce(nonce), null);
  assert.equal(parseNonce(String(U64_MAX)), U64_MAX);
  assert.equal((await validateChallenge(secret, proof, opts)).success, true);
});

test('incorrect work does not consume the challenge; storage errors fail closed', async () => {
  const challenge = generateChallenge(secret, { difficulty: 64, count: 1, scope: 'signup' });
  const state = createRuntime(module);
  const spec = challenge.challenges[0];
  let bad = 0n;
  try {
    while (true) {
      state.make(await seedFor(spec.c, bad / BigInt(spec.n)));
      if (state.hash(bad) > U64_MAX / BigInt(spec.d)) break;
      bad++;
    }
  } finally { state.free(); }
  let calls = 0;
  const store = async () => { calls++; return true; };
  assert.equal((await validateChallenge(secret, { token: challenge.token, solutions: [{ nonce: String(bad) }] }, { ...opts, consumeNonce: store })).reason, 'invalid_solution');
  assert.equal(calls, 0);
  const proof = await solve(challenge);
  assert.equal((await validateChallenge(secret, proof, { ...opts, consumeNonce: async () => { throw new Error('offline'); } })).reason, 'storage_error');
  assert.equal((await validateChallenge(secret, proof, { ...opts, consumeNonce: async () => 'OK' })).reason, 'already_used');
  assert.equal((await validateChallenge(secret, proof, opts)).success, true);
});

test('expired challenges and access tokens fail; expiry during storage fails', async () => {
  const now = Date.now;
  const start = now();
  const challenge = generateChallenge(secret, { difficulty: 1, count: 1, scope: 'signup', expiresMs: 1000 });
  assert.equal(challenge.ttlMs, 1000);
  const proof = { token: challenge.token, solutions: [{ nonce: '0' }] };
  try {
    Date.now = () => start + 2000;
    assert.equal((await validateChallenge(secret, proof, opts)).reason, 'expired');
    Date.now = () => start;
    const access = await validateChallenge(secret, proof, { ...opts, tokenTtlMs: 1000 });
    assert.equal(access.ttlMs, 1000);
    Date.now = () => start + 2000;
    assert.equal((await validateToken(secret, access.token, opts)).reason, 'expired');
    Date.now = () => start;
    const other = generateChallenge(secret, { difficulty: 1, count: 1, scope: 'signup', expiresMs: 1000 });
    const result = await validateChallenge(secret, { token: other.token, solutions: [{ nonce: '0' }] }, {
      ...opts, consumeNonce: async () => { Date.now = () => start + 2000; return true; },
    });
    assert.equal(result.reason, 'expired');
  } finally { Date.now = now; }
});

test('configuration rejects weak secrets, invalid bounds and missing replay protection', async () => {
  assert.throws(() => generateChallenge('weak'));
  for (const options of [{ difficulty: 0 }, { count: 65 }, { noncesPerHash: 0 }, { expiresMs: Infinity }, { scope: 'x'.repeat(257) }])
    assert.throws(() => generateChallenge(secret, options));
  await assert.rejects(() => validateToken(secret, 'bad', {}), /consumeNonce/);
  await assert.rejects(() => validateChallenge(secret, {}, { consumeNonce, tokenTtlMs: 0 }), /TTL/);
});

test('memory adapter expires keys and rejects simultaneous repeats', async () => {
  const key = `memory-test-${Math.random()}`;
  const now = Date.now;
  const start = now();
  try {
    Date.now = () => start;
    assert.equal(await consumeNonce(key, 1), true);
    assert.equal(await consumeNonce(key, 1000), false);
    Date.now = () => start + 100;
    assert.equal(await consumeNonce(key, 1000), true);
  }
  finally { Date.now = now; }
});
