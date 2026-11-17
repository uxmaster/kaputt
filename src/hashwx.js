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

/** @param {string} challenge @param {bigint} block */
export async function seedFor(challenge, block) {
  const input = new Uint8Array(40);
  for (let i = 0; i < 32; i++) input[i] = parseInt(challenge.slice(i * 2, i * 2 + 2), 16);
  new DataView(input.buffer).setBigUint64(32, block, true);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

/** Create an isolated runtime. Compiled mode falls back to the same HashWX interpreter.
 * @param {WebAssembly.Module} module @param {boolean} [compiled]
 */
export function createRuntime(module, compiled = false) {
  const w = new WebAssembly.Instance(module, {}).exports;
  w._initialize?.();
  let ctx = w.hashwx_alloc(compiled ? 1 : 0);
  if (ctx <= 0 && compiled) { compiled = false; ctx = w.hashwx_alloc(0); }
  if (ctx <= 0) throw new Error('HashWX allocation failed');
  let ptr = w.hashwx_seed(ctx);
  let exec;
  return {
    /** @param {Uint8Array} seed */
    make(seed) {
      new Uint8Array(w.memory.buffer, ptr, 32).set(seed);
      w.hashwx_make(ctx, ptr);
      exec = null;
      if (compiled) {
        try {
          const bytes = new Uint8Array(w.memory.buffer, w.hashwx_module(ctx), w.hashwx_module_size(ctx)).slice();
          exec = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory: w.memory } }).exports.exec;
        } catch {
          // CSP can permit the base module while disallowing generated modules.
          w.hashwx_free(ctx);
          compiled = false;
          ctx = w.hashwx_alloc(0);
          if (ctx <= 0) throw new Error('HashWX allocation failed');
          ptr = w.hashwx_seed(ctx);
          new Uint8Array(w.memory.buffer, ptr, 32).set(seed);
          w.hashwx_make(ctx, ptr);
        }
      }
    },
    /** @param {bigint} nonce */
    hash(nonce) {
      if (!exec) return BigInt.asUintN(64, w.hashwx_exec(ctx, nonce));
      w.hashwx_exec_begin(ctx, nonce);
      exec(w.hashwx_registers(ctx), w.hashwx_memory(ctx));
      return BigInt.asUintN(64, w.hashwx_exec_final(ctx));
    },
    free() { w.hashwx_free(ctx); },
  };
}
