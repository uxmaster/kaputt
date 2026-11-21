import { integer, validSpec } from './hashwx.js';

// The single-file build (src/browser.js bundled as IIFE with --define KAPUTT_VERSION='"<version>"') is a classic script and
// its own worker script: it takes its URL from document.currentScript in the page and from location in a worker, and asks
// for its WASM with ?v=<version>, so a new build never meets a cached old file.
const script = typeof KAPUTT_VERSION === 'undefined' ? '' : globalThis.document?.currentScript.src ?? location.href;

let modulePromise;
function loadModule() {
  modulePromise ??= fetch(typeof KAPUTT_VERSION === 'undefined'
    ? new URL('./hashwx.wasm', import.meta.url)
    : new URL(`./hashwx.wasm?v=${KAPUTT_VERSION}`, script)).then(async response => {
    if (!response.ok) throw new Error(`HashWX download failed: ${response.status}`);
    return WebAssembly.compile(await response.arrayBuffer());
  }).catch(error => { modulePromise = undefined; throw error; });
  return modulePromise;
}

/** Solve HashWX in classic workers, one per CPU core (at most 16, like Cap), each reused for its share of puzzles.
 * @param {{token: string, expires: number, ttlMs: number, challenges: import('./index.js').Puzzle[]}} challenge
 * @param {{signal?: AbortSignal, onProgress?: (percent: number) => void}} [options]
 * @returns {Promise<{token: string, solutions: {nonce: string}[]}>}
 */
export async function solveChallenges(challenge, { signal, onProgress = () => {} } = {}) {
  if (!challenge || typeof challenge.token !== 'string' || challenge.token.length > 16384 ||
    !Number.isSafeInteger(challenge.expires) || !integer(challenge.ttlMs, 1, 86_400_000) ||
    !Array.isArray(challenge.challenges) || !integer(challenge.challenges.length, 1, 64) ||
    !challenge.challenges.every(validSpec)) throw new Error('Invalid challenge');
  signal?.throwIfAborted();
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
      // classic, not { type: 'module' }: Firefox before 114 cannot start module workers
      const worker = typeof KAPUTT_VERSION === 'undefined' ? new Worker(new URL('./worker.js', import.meta.url)) : new Worker(script);
      workers.add(worker);
      while (next < solutions.length) {
        const index = next++;
        solutions[index] = await new Promise((resolve, reject) => {
          worker.onmessage = ({ data }) => {
            if (data.error) reject(new Error(data.error));
            else if (typeof data.nonce === 'string') resolve({ nonce: data.nonce });
          };
          worker.onerror = event => reject(new Error(event.message || 'HashWX worker failed'));
          worker.onmessageerror = () => reject(new Error('HashWX worker message failed'));
          worker.postMessage({ module, spec: challenge.challenges[index] });
        });
        onProgress(Math.round(++completed / solutions.length * 100));
      }
    }
    const lanes = Math.min(navigator.hardwareConcurrency || 4, 16, solutions.length);
    await Promise.race([Promise.all(Array.from({ length: lanes }, run)), stopped]);
    return { token: challenge.token, solutions };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    for (const worker of workers) worker.terminate();
  }
}
