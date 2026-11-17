import { solveChallenges } from './client.js';

/** Cap's visual widget, with HashWX only. Configure callbacks or an application-owned endpoint.
 * Emits progress, solve ({token, expires}), error ({message}), and reset events.
 */
export class KaputtWidget extends HTMLElement {
  /** @type {null|((signal: AbortSignal) => Promise<object>)} */
  createChallenge = null;
  /** @type {null|((proof: object, signal: AbortSignal) => Promise<object>)} */
  redeemChallenge = null;
  token = null;
  #controller;
  #pending;
  #expiry;
  #expires = 0;
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
          <p part="label" class="label-wrapper"><span id="label" class="label active" role="status" aria-live="polite">Verify to continue</span></p>
        </button>
        <a class="credits" href="https://github.com/uxmaster/kaputt" target="_blank" rel="noopener" title="CAPTCHA ist kaputt">kaputt</a>
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
  disconnectedCallback() { this.reset(); }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
  #update(state, label) {
    if (state) this.#box.dataset.state = state;
    else delete this.#box.dataset.state;
    this.#label.textContent = label;
    this.#trigger.disabled = state === 'verifying' || state === 'done';
    this.#trigger.setAttribute('aria-busy', String(state === 'verifying'));
  }
  async #request(route, body, signal) {
    const endpoint = this.getAttribute('api-endpoint');
    if (!endpoint) throw new Error('Set api-endpoint or provide challenge callbacks');
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/${route}`, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Kaputt request failed: ${response.status}`);
    return response.json();
  }

  /** Programmatically execute the same flow as clicking the widget. @returns {Promise<string>} */
  solve() {
    if (this.token && this.#expires > Date.now()) return Promise.resolve(this.token);
    if (this.token) this.reset();
    if (this.#pending) return this.#pending;
    const controller = new AbortController();
    this.#controller = controller;
    const { signal } = controller;
    this.#update('verifying', 'Verifying...');
    this.#pending = Promise.resolve().then(() => this.#execute(signal)).finally(() => {
      if (this.#controller === controller) { this.#pending = null; this.#controller = null; }
    });
    return this.#pending;
  }
  async #execute(signal) {
    try {
      signal.throwIfAborted();
      const challenge = await (this.createChallenge ? this.createChallenge(signal) : this.#request('challenge', {}, signal));
      signal.throwIfAborted();
      const proof = await solveChallenges(challenge, { signal, onProgress: progress => {
        this.#root.querySelector('.progress-ring-circle').style.strokeDashoffset = String(87.96 * (1 - progress / 100));
        this.#emit('progress', { progress });
      } });
      const result = await (this.redeemChallenge ? this.redeemChallenge(proof, signal) : this.#request('redeem', proof, signal));
      signal.throwIfAborted();
      if (result.success !== true || typeof result.token !== 'string' || !Number.isSafeInteger(result.expires) ||
        result.expires <= Date.now() || result.expires - Date.now() > 86_400_000) throw new Error('Proof of work was rejected');
      this.token = this.#field.value = result.token;
      this.#expires = result.expires;
      this.#update('done', 'Verified');
      this.#expiry = setTimeout(() => this.reset(), result.expires - Date.now());
      this.#emit('solve', { token: result.token, expires: result.expires });
      return result.token;
    } catch (error) {
      if (!signal.aborted) { this.#update('error', 'Error. Try again.'); this.#emit('error', { message: error.message }); }
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
    this.#expires = 0;
    this.#field.value = '';
    this.#root.querySelector('.progress-ring-circle').style.strokeDashoffset = '87.96';
    this.#update('', 'Verify to continue');
    this.#emit('reset');
  }
}

if (!customElements.get('kaputt-widget')) customElements.define('kaputt-widget', KaputtWidget);
