// HashWX solver adapted from Cap (Apache-2.0); see NOTICE.
// A classic script, not a module: Firefox before 114 cannot start module workers.
// The server imports the same runtime through module.exports, so browser and server hash alike.
const U64_MAX = (1n << 64n) - 1n;

/** @param {string} challenge @param {bigint} block */
async function seedFor(challenge, block) {
  const input = new Uint8Array(40);
  for (let i = 0; i < 32; i++) input[i] = parseInt(challenge.slice(i * 2, i * 2 + 2), 16);
  new DataView(input.buffer).setBigUint64(32, block, true);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

/** Create an isolated runtime. Compiled mode falls back to the same HashWX interpreter.
 * @param {WebAssembly.Module} module @param {boolean} [compiled]
 */
function createRuntime(module, compiled = false) {
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

let state; // one runtime per worker, reused for every puzzle it solves
// The single-file build (src/browser.js) also evaluates this script in the page; only a worker listens.
if (typeof DedicatedWorkerGlobalScope === 'function' && self instanceof DedicatedWorkerGlobalScope) {
  self.onmessage = async ({ data: { module, spec } }) => {
    try {
      state ??= createRuntime(module, true);
      const target = U64_MAX / BigInt(spec.d);
      const per = BigInt(spec.n);
      for (let block = 0n; block * per <= U64_MAX; block++) {
        state.make(await seedFor(spec.c, block));
        for (let k = 0n; k < per; k++) {
          const nonce = block * per + k;
          if (nonce > U64_MAX) throw new Error('Nonce space exhausted');
          if (state.hash(nonce) <= target) {
            self.postMessage({ nonce: nonce.toString() });
            return;
          }
        }
      }
      throw new Error('Nonce space exhausted');
    } catch (error) {
      self.postMessage({ error: error.message });
    }
  };
}
if (typeof module === 'object') module.exports = { createRuntime, seedFor };
