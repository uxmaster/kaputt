import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { generateChallenge, validateChallenge, validateToken } from '../src/index.js';
import { consumeNonce } from '../examples/memory.js';

const secret = 'browser-test-secret-at-least-32-bytes';
const options = { scope: 'test', consumeNonce };
const contentTypes = { js: 'text/javascript', css: 'text/css', wasm: 'application/wasm' };
const errors = [];
const requests = [];
const headers = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src 'self'; img-src 'self' data:; connect-src 'self'",
};
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0, maxRequestBodySize: 32768,
  async fetch(req) {
    try {
      const url = new URL(req.url);
      if (url.pathname === '/') return new Response(
        '<!doctype html><html lang="en"><title>Kaputt test</title><script type="module" src="/src/widget.js"></script><form><kaputt-widget api-endpoint="/pow"></kaputt-widget></form></html>',
        { headers: { ...headers, 'Content-Type': 'text/html' } },
      );
      if (url.pathname === '/pow/challenge') return Response.json(
        generateChallenge(secret, { difficulty: 128, count: 4, noncesPerHash: 16, scope: 'test' }), { headers },
      );
      if (url.pathname === '/pow/redeem') return Response.json(
        await validateChallenge(secret, await req.json(), options), { headers },
      );
      if (/^\/src\/[a-z.-]+$/.test(url.pathname)) return new Response(
        Bun.file(new URL(`..${url.pathname}`, import.meta.url)),
        { headers: { ...headers, 'Content-Type': contentTypes[url.pathname.split('.').pop()] || 'text/plain' } },
      );
      return new Response('Not found', { status: 404, headers });
    } catch (error) { return new Response(error.message, { status: 500, headers }); }
  },
});
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.waitForFunction(() => customElements.get('kaputt-widget'));
  assert.equal(await page.getByRole('button', { name: 'Verify to continue', exact: true }).count(), 1);
  const trigger = page.locator('kaputt-widget').getByRole('button');
  await trigger.focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('kaputt-widget').token);
  const token = await page.locator('kaputt-widget').evaluate(widget => widget.token);
  assert.equal((await validateToken(secret, token, options)).success, true);
  assert.equal((await validateToken(secret, token, options)).success, false);
  assert.equal(await page.locator('input[name="kaputt-token"]').inputValue(), token);
  assert.equal(await page.locator('.captcha').evaluate(el => getComputedStyle(el).width), '260px');
  assert.equal(await page.locator('.captcha').evaluate(el => getComputedStyle(el).height), '58px');
  assert.equal(await trigger.isDisabled(), true);
  assert.equal(await page.locator('.label').textContent(), 'Verified');
  assert.equal(await page.locator('kaputt-widget').evaluate(async widget => {
    widget.reset();
    const p = widget.solve();
    const same = p === widget.solve();
    await p;
    return same;
  }), true);

  // A suspended tab can delay the expiry timer; solve() must check the timestamp itself.
  assert.equal(await page.evaluate(async () => {
    const widget = document.querySelector('kaputt-widget');
    const oldToken = widget.token;
    const now = Date.now;
    let issued = 0;
    widget.createChallenge = async signal => {
      issued++;
      Date.now = now;
      const response = await fetch('/pow/challenge', { method: 'POST', signal });
      return response.json();
    };
    try {
      Date.now = () => now() + 86_400_000;
      const newToken = await widget.solve();
      return issued === 1 && newToken !== oldToken;
    } finally { Date.now = now; widget.createChallenge = null; }
  }), true);

  // An error listener may reset synchronously; the next solve must start fresh work.
  assert.equal(await page.evaluate(async () => {
    const widget = document.querySelector('kaputt-widget');
    widget.reset();
    let calls = 0;
    widget.createChallenge = () => { calls++; throw new Error('synchronous failure'); };
    widget.addEventListener('error', () => widget.reset(), { once: true });
    let rejected = false;
    try { await widget.solve(); } catch { rejected = true; }
    widget.createChallenge = async signal => {
      calls++;
      const response = await fetch('/pow/challenge', { method: 'POST', signal });
      return response.json();
    };
    try { return rejected && !!await widget.solve() && calls === 2; }
    finally { widget.createChallenge = null; }
  }), true);

  // Direct solver and application callbacks use the same protocol as the endpoint flow.
  const direct = generateChallenge(secret, { difficulty: 64, count: 2, scope: 'test' });
  const proof = await page.evaluate(async challenge => {
    const { solveChallenges } = await import('/src/client.js');
    return solveChallenges(challenge);
  }, direct);
  assert.equal((await validateChallenge(secret, proof, options)).success, true);

  const defaultChallenge = generateChallenge(secret, { scope: 'test' });
  const started = performance.now();
  const defaultProof = await page.evaluate(async challenge => {
    const { solveChallenges } = await import('/src/client.js');
    return solveChallenges(challenge);
  }, defaultChallenge);
  assert.equal((await validateChallenge(secret, defaultProof, options)).success, true);
  console.log(`Default difficulty solved in ${Math.round(performance.now() - started)} ms on this browser run.`);

  // Cancellation while workers are hashing must release them and leave the widget retryable.
  const hard = generateChallenge(secret, { difficulty: 1_000_000_000, count: 4, scope: 'test' });
  assert.equal(await page.evaluate(async challenge => {
    const widget = document.querySelector('kaputt-widget');
    widget.reset();
    widget.createChallenge = async () => challenge;
    const promise = widget.solve();
    await new Promise(resolve => setTimeout(resolve, 100));
    widget.reset();
    try { await promise; return false; } catch { return widget.token === null; }
  }, hard), true);
  await page.waitForFunction(() => document.querySelector('kaputt-widget').shadowRoot.querySelector('button').disabled === false);
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const check = () => {
      if (page.workers().length === 0) resolve();
      else if (Date.now() > deadline) reject(new Error(`${page.workers().length} workers still running`));
      else setTimeout(check, 25);
    };
    check();
  });

  assert.equal(await page.evaluate(async () => {
    const widget = document.querySelector('kaputt-widget');
    widget.createChallenge = null;
    widget.redeemChallenge = async (proof, signal) => {
      const response = await fetch('/pow/redeem', { method: 'POST', signal, body: JSON.stringify(proof) });
      return response.json();
    };
    const token = await widget.solve();
    widget.remove();
    document.querySelector('form').append(widget);
    return !!token && widget.token === null;
  }), true);

  await page.route('**/pow/redeem', route => route.fulfill({ status: 503, body: 'offline' }));
  await trigger.click();
  await page.waitForFunction(() => document.querySelector('kaputt-widget').shadowRoot.querySelector('.captcha').dataset.state === 'error');
  assert.equal(await trigger.isEnabled(), true);
  await page.unroute('**/pow/redeem');
  await trigger.click();
  await page.waitForFunction(() => document.querySelector('kaputt-widget').token);
  assert.deepEqual(errors, []);
  assert(requests.every(url => url.startsWith(`http://127.0.0.1:${server.port}/`)));
  console.log('Browser checks passed: keyboard, Cap dimensions, real HashWX workers, replay, direct solver, callbacks, cancellation, reconnect, expiry, synchronous error reset, error and retry, same-origin CSP.');
} finally {
  await browser?.close();
  await server.stop(true);
}
