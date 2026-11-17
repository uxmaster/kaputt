import { integer, validSpec } from './hashwx.js';

let modulePromise;
function loadModule() {
  modulePromise ??= fetch(new URL('./hashwx.wasm', import.meta.url)).then(async response => {
    if (!response.ok) throw new Error(`HashWX download failed: ${response.status}`);
    return WebAssembly.compile(await response.arrayBuffer());
  }).catch(error => { modulePromise = undefined; throw error; });
  return modulePromise;
}

/** Solve HashWX in module workers, without inspecting the browser environment.
 * @param {{token: string, expires: number, ttlMs: number, challenges: import('./index.js').Puzzle[]}} challenge
 * @param {{signal?: AbortSignal, onProgress?: (percent: number) => void}} [options]
 * @returns {Promise<{token: string, solutions: {nonce: string}[]}>}
 */
export async function solveChallenges(challenge, { signal, onProgress = () => {} } = {}) {
  if (!challenge || typeof challenge.token !== 'string' || challenge.token.length > 16384 ||
    !Number.isSafeInteger(challenge.expires) || !integer(challenge.ttlMs, 1, 86_400_000) ||
    !Array.isArray(challenge.challenges) || !integer(challenge.challenges.length, 1, 64) ||
    !challenge.challenges.every(validSpec)) throw new Error('Invalid challenge');
  const workers = new Set();
  let timer;
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => reject(new Error('Challenge expired')), challenge.ttlMs);
    if (signal?.aborted) abort();
  });
  try {
    const module = await Promise.race([loadModule(), stopped]);
    const solutions = new Array(challenge.challenges.length);
    let next = 0;
    let completed = 0;
    onProgress(0);
    async function run() {
      while (next < solutions.length) {
        const index = next++;
        const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        workers.add(worker);
        try {
          solutions[index] = await new Promise((resolve, reject) => {
            worker.onmessage = ({ data }) => {
              if (data.error) reject(new Error(data.error));
              else if (typeof data.nonce === 'string') resolve({ nonce: data.nonce });
            };
            worker.onerror = event => reject(new Error(event.message || 'HashWX worker failed'));
            worker.onmessageerror = () => reject(new Error('HashWX worker message failed'));
            worker.postMessage({ module, spec: challenge.challenges[index] });
          });
        } finally { worker.terminate(); workers.delete(worker); }
        onProgress(Math.round(++completed / solutions.length * 100));
      }
    }
    await Promise.race([Promise.all(Array.from({ length: Math.min(4, solutions.length) }, run)), stopped]);
    return { token: challenge.token, solutions };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    for (const worker of workers) worker.terminate();
  }
}
