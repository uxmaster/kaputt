// HashWX solver adapted from Cap (Apache-2.0); see NOTICE.
import { createRuntime, seedFor, U64_MAX } from './hashwx.js';

self.onmessage = async ({ data: { module, spec } }) => {
  let state;
  try {
    state = createRuntime(module, true);
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
  } finally { state?.free(); }
};
