import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { generateChallenge, validateChallenge, validateToken } from '../src/index.js';
import { consumeNonce } from '../examples/memory.js';

const secret = 'browser-test-secret-at-least-32-bytes';
const options = { scope: 'test', consumeNonce };
const contentTypes = { js: 'text/javascript', css: 'text/css', wasm: 'application/wasm' };
const errors = [];
const requests = [];
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src 'self'; img-src 'self' data:; connect-src 'self'");
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      return res.end('<!doctype html><html lang="en"><title>Kaputt test</title><script type="module" src="/src/widget.js"></script><form><kaputt-widget api-endpoint="/pow"></kaputt-widget></form></html>');
    }
    if (url.pathname === '/pow/challenge') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(generateChallenge(secret, { difficulty: 128, count: 4, noncesPerHash: 16, scope: 'test' })));
    }
    if (url.pathname === '/pow/redeem') {
      let body = '';
      for await (const part of req) { body += part; if (body.length > 32768) throw new Error('Body too large'); }
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(await validateChallenge(secret, JSON.parse(body), options)));
    }
    if (/^\/src\/[a-z.-]+$/.test(url.pathname)) {
      res.setHeader('Content-Type', contentTypes[url.pathname.split('.').pop()] || 'text/plain');
      return res.end(await readFile(new URL(`..${url.pathname}`, import.meta.url)));
    }
    res.statusCode = 404; res.end();
  } catch (error) { res.statusCode = 500; res.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
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
  assert(requests.every(url => url.startsWith(`http://127.0.0.1:${server.address().port}/`)));
  console.log('Browser checks passed: keyboard, Cap dimensions, real HashWX workers, replay, direct solver, callbacks, cancellation, reconnect, expiry, synchronous error reset, error and retry, same-origin CSP.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
