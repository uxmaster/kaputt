import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { generateChallenge, validateChallenge, validateToken } from '../src/index.js';
import { consumeNonce } from '../examples/memory.js';

const secret = 'browser-test-secret-at-least-32-bytes';
const options = { scope: 'test', consumeNonce };
const contentTypes = { js: 'text/javascript', css: 'text/css', wasm: 'application/wasm' };
const errors = [];
const requests = [];
let customHeaders = 0;
const headers = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src 'self'; img-src 'self' data:; connect-src 'self'",
};
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0, maxRequestBodySize: 32768,
  async fetch(req) {
    try {
      const url = new URL(req.url);
      if (url.pathname === '/' || url.pathname === '/upgrade') return new Response(
        '<!doctype html><html lang="en"><title>Kaputt test</title><form><kaputt-widget api-endpoint="/pow"></kaputt-widget></form>' +
        (url.pathname === '/upgrade' ? '<script src="/preconfigure.js"></script>' : '') +
        '<script type="module" src="/src/widget.js"></script></html>',
        { headers: { ...headers, 'Content-Type': 'text/html' } },
      );
      if (url.pathname === '/i18n') return new Response(
        '<!doctype html><html lang="pl"><meta charset="utf-8"><title>Kaputt i18n</title><form><kaputt-widget id="a" api-endpoint="/pow" label-initial="Jestem człowiekiem" label-verifying="Sprawdzam..." label-solved="Gotowe" label-error="Błąd" label-wasm-disabled="Włącz WebAssembly. Bez tego weryfikacja nie zadziała."></kaputt-widget><kaputt-widget id="b" api-endpoint="/pow"></kaputt-widget></form>' +
        '<script src="/custom-fetch.js"></script><script type="module" src="/src/widget.js"></script></html>',
        { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } },
      );
      if (url.pathname === '/custom-fetch.js') return new Response(`
        window.customFetches = 0;
        window.KAPUTT_CUSTOM_FETCH = (url, options) => { customFetches++; return fetch(url, { ...options, headers: { ...options.headers, 'x-token': 'x' } }); };
      `, { headers: { ...headers, 'Content-Type': 'text/javascript' } });
      if (url.pathname.startsWith('/pow/') && req.headers.get('x-token')) customHeaders++;
      if (url.pathname === '/preconfigure.js') return new Response(`
        const widget = document.querySelector('kaputt-widget');
        widget.removeAttribute('api-endpoint');
        window.configuredBeforeUpgrade = !customElements.get('kaputt-widget');
        window.callbackCalls = [];
        widget.createChallenge = async signal => {
          window.callbackCalls.push('challenge');
          return (await fetch('/pow/challenge', { method: 'POST', signal })).json();
        };
        widget.redeemChallenge = async (proof, signal) => {
          window.callbackCalls.push('redeem');
          return (await fetch('/pow/redeem', { method: 'POST', signal, body: JSON.stringify(proof) })).json();
        };
      `, { headers: { ...headers, 'Content-Type': 'text/javascript' } });
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

  // Delayed timers must not make solve() return a token past its relative lifetime.
  assert.equal(await page.evaluate(async () => {
    const widget = document.querySelector('kaputt-widget');
    const oldToken = widget.token;
    const now = performance.now;
    let issued = 0;
    widget.createChallenge = async signal => {
      issued++;
      performance.now = now;
      const response = await fetch('/pow/challenge', { method: 'POST', signal });
      return response.json();
    };
    try {
      performance.now = () => now.call(performance) + 86_400_000;
      const newToken = await widget.solve();
      return issued === 1 && newToken !== oldToken;
    } finally { performance.now = now; widget.createChallenge = null; }
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

  // Widget-local error/reset events must not reach native form or window handlers.
  assert.deepEqual(await page.evaluate(async () => {
    const widget = document.querySelector('kaputt-widget');
    widget.reset();
    const counts = { widgetError: 0, widgetReset: 0, windowError: 0, formReset: 0 };
    const onWindowError = () => counts.windowError++;
    const onFormReset = () => counts.formReset++;
    window.addEventListener('error', onWindowError);
    const form = widget.closest('form');
    form.addEventListener('reset', onFormReset);
    widget.addEventListener('error', () => counts.widgetError++, { once: true });
    widget.addEventListener('reset', () => counts.widgetReset++, { once: true });
    widget.createChallenge = () => { throw new Error('expected failure'); };
    try { await widget.solve(); } catch {}
    widget.reset();
    widget.createChallenge = null;
    window.removeEventListener('error', onWindowError);
    form.removeEventListener('reset', onFormReset);
    return counts;
  }), { widgetError: 1, widgetReset: 1, windowError: 0, formReset: 0 });

  const upgradePage = await browser.newPage();
  await upgradePage.goto(`http://127.0.0.1:${server.port}/upgrade`);
  await upgradePage.waitForFunction(() => customElements.get('kaputt-widget'));
  assert.equal(await upgradePage.evaluate(() => window.configuredBeforeUpgrade), true);
  const upgradeToken = await upgradePage.locator('kaputt-widget').evaluate(widget => widget.solve());
  assert.deepEqual(await upgradePage.evaluate(() => window.callbackCalls), ['challenge', 'redeem']);
  assert.equal((await validateToken(secret, upgradeToken, options)).success, true);
  await upgradePage.close();

  for (const offset of [15 * 60_000, 30 * 60_000, -2 * 86_400_000]) {
    const skewPage = await browser.newPage();
    await skewPage.addInitScript(offset => {
      const now = Date.now;
      Date.now = () => now() + offset;
    }, offset);
    await skewPage.goto(`http://127.0.0.1:${server.port}`);
    await skewPage.waitForFunction(() => customElements.get('kaputt-widget'));
    const token = await skewPage.locator('kaputt-widget').evaluate(async widget => {
      const token = await widget.solve();
      Date.now = () => 0;
      return token === await widget.solve() ? token : null;
    });
    assert.equal((await validateToken(secret, token, options)).success, true);
    await skewPage.close();
  }

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
  assert.equal(await page.evaluate(async challenge => {
    const { solveChallenges } = await import('/src/client.js');
    try { await solveChallenges({ ...challenge, ttlMs: 25 }); return false; }
    catch (error) { return error.message === 'Challenge expired'; }
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
  // Custom labels and a global custom fetch for api-endpoint requests.
  const i18n = await browser.newPage({ reducedMotion: 'reduce' });
  i18n.on('pageerror', error => errors.push(error.message));
  await i18n.goto(`http://127.0.0.1:${server.port}/i18n`);
  await i18n.waitForFunction(() => customElements.get('kaputt-widget'));
  const label = id => i18n.locator(`#${id} .label`).textContent();
  assert.equal(await label('a'), 'Jestem człowiekiem');
  assert.equal(await label('b'), 'Verify to continue');
  const before = customHeaders;
  const tokenA = await i18n.evaluate(() => document.getElementById('a').solve());
  assert.equal((await validateToken(secret, tokenA, options)).success, true);
  assert.equal(await label('a'), 'Gotowe');
  assert.equal(await i18n.evaluate(() => customFetches), 2);
  assert.equal(customHeaders - before, 2);
  await i18n.close();

  // Without WebAssembly the widget says so instead of a generic error, and makes no request.
  const noWasm = await browser.newPage({ reducedMotion: 'reduce' });
  noWasm.on('pageerror', error => errors.push(error.message));
  await noWasm.addInitScript(() => { delete globalThis.WebAssembly; });
  await noWasm.goto(`http://127.0.0.1:${server.port}/i18n`);
  await noWasm.waitForFunction(() => customElements.get('kaputt-widget'));
  assert.equal(await noWasm.evaluate(async () => {
    const results = [];
    for (const widget of document.querySelectorAll('kaputt-widget')) {
      try { await widget.solve(); } catch {}
      const label = widget.shadowRoot.querySelector('.label'), wrapper = label.parentElement;
      const fits = label.scrollWidth <= wrapper.clientWidth && label.offsetHeight <= wrapper.clientHeight;
      results.push(label.textContent, widget.shadowRoot.querySelector('.captcha').dataset.state, fits);
    }
    return [...results, customFetches].join('|');
  }), 'Włącz WebAssembly. Bez tego weryfikacja nie zadziała.|error|true|Verification needs WebAssembly. Please enable it.|error|true|0');
  // A long label on a widget shown only later (hidden-until-submit) must refit once visible.
  assert.equal(await noWasm.evaluate(async () => {
    const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const widget = document.getElementById('a');
    widget.style.display = 'none';
    await frames(); // hidden since page load, as in a show-on-submit form
    widget.reset();
    try { await widget.solve(); } catch {}
    const whileHidden = widget.shadowRoot.querySelector('.label-wrapper').classList.contains('long');
    widget.style.display = '';
    await frames();
    return !whileHidden && widget.shadowRoot.querySelector('.label-wrapper').classList.contains('long');
  }), true);
  await noWasm.close();

  assert.deepEqual(errors, []);
  assert(requests.every(url => url.startsWith(`http://127.0.0.1:${server.port}/`)));
  console.log('Browser checks passed: keyboard, Cap dimensions, real HashWX workers, replay, direct solver, callbacks, cancellation, reconnect, relative expiry, clock skew, pre-upgrade callbacks, event isolation, custom labels, custom fetch, WebAssembly disabled, long-label fit, synchronous error reset, error and retry, same-origin CSP.');
} finally {
  await browser?.close();
  await server.stop(true);
}
