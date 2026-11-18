// Widget markup adapted from Cap (Apache-2.0); see NOTICE.
import { solveChallenges } from './client.js';
import { integer } from './hashwx.js';

// The smallest valid module: compiling it fails when WASM is absent or blocked (Lockdown Mode, CSP).
const wasmAvailable = () => {
  try { return !!new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); } catch { return false; }
};
const LABELS = {
  initial: 'Verify to continue', verifying: 'Verifying...', solved: 'Verified',
  error: 'Error. Try again.', 'wasm-disabled': 'Verification needs WebAssembly. Please enable it.',
};

/** Cap's visual widget, with HashWX only. Configure callbacks or an application-owned endpoint.
 * Labels come from label-initial, label-verifying, label-solved, label-error and label-wasm-disabled.
 * Endpoint requests use window.KAPUTT_CUSTOM_FETCH when defined (fetch-compatible signature).
 * Emits progress, solve ({token, expires}), error ({message}), and reset events.
 * @property {null|((signal: AbortSignal) => Promise<object>)} [createChallenge] Optional transport callback.
 * @property {null|((proof: object, signal: AbortSignal) => Promise<object>)} [redeemChallenge] Optional transport callback.
 */
export class KaputtWidget extends HTMLElement {
  static observedAttributes = Object.keys(LABELS).map(key => `label-${key}`);
  token = null;
  #key = 'initial';
  #controller;
  #pending;
  #expiry;
  #deadline = 0;
  #root = this.attachShadow({ mode: 'open' });
  #box;
  #trigger;
  #label;
  #field = document.createElement('input');

  constructor() {
    super();
    this.#root.innerHTML = `<link rel="stylesheet" href="${new URL('./widget.css', import.meta.url)}">
      <div class="captcha" role="group" aria-label="Kaputt proof of work">
        <button class="captcha-trigger" type="button" aria-labelledby="label">
          <div class="checkbox" part="checkbox" aria-hidden="true"><svg class="progress-ring" viewBox="0 0 32 32"><circle class="progress-ring-bg" cx="16" cy="16" r="14"></circle><circle class="progress-ring-circle" cx="16" cy="16" r="14"></circle></svg></div>
          <p part="label" class="label-wrapper"><span id="label" class="label" role="status" aria-live="polite">Verify to continue</span></p>
        </button>
      </div>`;
    this.#box = this.#root.querySelector('.captcha');
    this.#trigger = this.#root.querySelector('button');
    this.#label = this.#root.querySelector('.label');
    this.#field.type = 'hidden';
    this.#trigger.addEventListener('click', () => { this.solve().catch(() => {}); });
  }

  connectedCallback() {
    this.#field.name = this.getAttribute('name') || 'kaputt-token';
    this.append(this.#field);
  }
  attributeChangedCallback() { this.#update(this.#box.dataset.state, this.#key); }
  disconnectedCallback() { this.reset(); }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  #update(state, key) {
    if (state) this.#box.dataset.state = state;
    else delete this.#box.dataset.state;
    this.#key = key;
    this.#label.textContent = this.getAttribute(`label-${key}`) || LABELS[key];
    this.#trigger.disabled = state === 'verifying' || state === 'done';
    this.#trigger.setAttribute('aria-busy', String(state === 'verifying'));
  }
  async #request(route, body, signal) {
    const endpoint = this.getAttribute('api-endpoint');
    if (!endpoint) throw new Error('Set api-endpoint or provide challenge callbacks');
    const request = globalThis.KAPUTT_CUSTOM_FETCH || fetch;
    const response = await request(`${endpoint.replace(/\/$/, '')}/${route}`, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Kaputt request failed: ${response.status}`);
    return response.json();
  }

  /** Programmatically execute the same flow as clicking the widget. @returns {Promise<string>} */
  solve() {
    if (this.token && this.#deadline > performance.now()) return Promise.resolve(this.token);
    if (this.token) this.reset();
    if (this.#pending) return this.#pending;
    const controller = new AbortController();
    this.#controller = controller;
    const { signal } = controller;
    this.#update('verifying', 'verifying');
    this.#pending = Promise.resolve().then(() => this.#execute(signal)).finally(() => {
      if (this.#controller === controller) { this.#pending = null; this.#controller = null; }
    });
    return this.#pending;
  }
  async #execute(signal) {
    // Without WASM the proof can never be solved, so skip the network.
    const wasm = wasmAvailable();
    try {
      signal.throwIfAborted();
      if (!wasm) throw new Error('WebAssembly is disabled');
      const challenge = await (this.createChallenge ? this.createChallenge(signal) : this.#request('challenge', {}, signal));
      signal.throwIfAborted();
      const proof = await solveChallenges(challenge, { signal, onProgress: progress => {
        this.#root.querySelector('.progress-ring-circle').style.strokeDashoffset = String(87.96 * (1 - progress / 100));
        this.#emit('progress', { progress });
      } });
      const result = await (this.redeemChallenge ? this.redeemChallenge(proof, signal) : this.#request('redeem', proof, signal));
      signal.throwIfAborted();
      if (result.success !== true || typeof result.token !== 'string' || !Number.isSafeInteger(result.expires) ||
        !integer(result.ttlMs, 1, 86_400_000)) throw new Error('Proof of work was rejected');
      this.token = this.#field.value = result.token;
      this.#deadline = performance.now() + result.ttlMs;
      this.#update('done', 'solved');
      this.#expiry = setTimeout(() => this.reset(), result.ttlMs);
      this.#emit('solve', { token: result.token, expires: result.expires });
      return result.token;
    } catch (error) {
      if (!signal.aborted) { this.#update('error', wasm ? 'error' : 'wasm-disabled'); this.#emit('error', { message: error.message }); }
      throw error;
    }
  }
  /** Cancel pending work and discard the local token. */
  reset() {
    this.#controller?.abort();
    this.#controller = null;
    this.#pending = null;
    clearTimeout(this.#expiry);
    this.token = null;
    this.#deadline = 0;
    this.#field.value = '';
    this.#root.querySelector('.progress-ring-circle').style.strokeDashoffset = '87.96';
    this.#update('', 'initial');
    this.#emit('reset');
  }
}

if (!customElements.get('kaputt-widget')) customElements.define('kaputt-widget', KaputtWidget);
