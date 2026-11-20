# kaputt

**CAPTCHA ist kaputt.**

Bots can beat people at spotting buses, bicycles and street signs or reading
distorted text. They can also tune their browsers to look more “human” to detection
scripts than real users do. Privacy tools, extensions and unusual settings can
flag legitimate visitors while bots copy the expected defaults.

kaputt drops that guessing game. No puzzles or browser profiling: just verifiable
work that makes abuse more expensive.

HashWX proof of work for your own Bun application. Inspired by
[Cap](https://github.com/tiagozip/cap), with the same widget styling and a smaller
scope: make requests cost work. No browser instrumentation, fingerprinting,
behavior scoring, tracking, external services, or alternative PoW algorithms.

Plain JavaScript with JSDoc, ES modules, zero runtime dependencies. The original
HashWX WebAssembly binary ships locally. No TypeScript, Svelte, build step,
standalone server, dashboard, or built-in storage.

PoW is a cost barrier, not proof that someone is human. Bots can solve it too.

## Install

Install from GitHub:

```sh
bun add github:uxmaster/kaputt
```

Server: Bun 1.4.4+. WASM loading uses `Bun.file`; cryptography uses Bun's
implementation of `node:crypto`.
Browser: ES modules, module workers, WebAssembly, BigInt, and Web Crypto in a
secure context (HTTPS, or localhost for development). Browsers with WebAssembly
disabled cannot solve HashWX; there is no weaker fallback protocol.

## Server integration

Provide your own HTTP routes and an atomic replay store. The module never starts
a server or saves application data. Keep a random secret of at least 32 bytes on
the server, shared by all application instances. For example, generate one with
`openssl rand -hex 32` and load it from your environment.

```js
import { generateChallenge, validateChallenge, validateToken } from 'kaputt';
import { consumeNonce } from './your-store.js';

const secret = Bun.env.KAPUTT_SECRET;
const policy = { scope: 'signup', consumeNonce };

// POST /pow/challenge — return this object as JSON.
const challenge = generateChallenge(secret, { scope: 'signup' });

// POST /pow/redeem — parse and size-limit the request JSON in your HTTP layer.
const result = await validateChallenge(secret, requestBody, policy);
// Return result as JSON. Only success:true includes an access token.

// Your protected action, e.g. POST /signup:
const checked = await validateToken(secret, submittedToken, policy);
if (!checked.success) {
  // Reject the request; do not perform the protected action.
} else {
  // Perform one signup. The token has now been consumed.
}
```

The two validation calls must use the same scope. Use distinct scopes for
unrelated actions. A token is a bearer credential for one action within that
scope; it is not bound to a person, session, or request body. If your application
requires that binding, derive the scope server-side from the action and session
and use that value consistently at issuance, redemption, and the protected action.
Never let a client choose the expected scope or difficulty policy.

The challenge is signed and stateless. After successful proof verification,
`validateChallenge` atomically consumes its replay key and issues a signed access
token. `validateToken` atomically consumes that token's separate replay key. Both
steps require your callback; replay protection cannot accidentally be omitted.
Invalid work does not consume a challenge. Store failures deny access.

Validate the business request before consuming its token. Once consumed, a token
cannot be retried, even if your protected action later fails. Transactions or
idempotency for the business operation belong to your application.

## Widget

Serve **all of `node_modules/kaputt/src/`** at a same-origin path such as
`/assets/kaputt/`, preserving filenames. Your HTTP framework or bundler owns this
mapping. Serve `.js` as JavaScript, `.css` as CSS and `.wasm` as
`application/wasm`. No CDN or network requests to Cap are used.

```html
<script type="module" src="/assets/kaputt/widget.js"></script>
<form id="signup">
  <!-- The widget POSTs to /pow/challenge and /pow/redeem. -->
  <kaputt-widget api-endpoint="/pow" name="kaputt-token"></kaputt-widget>
  <button type="submit">Sign up</button>
</form>
```

The widget keeps Cap 0.1.34's 230 × 58 px look, checkbox, progress ring,
checkmark, error state, and CSS customization variables (`--cap-*`), without
branding. Its labels say “Verify to continue” and “Verified”: work does not prove
humanity. It supports keyboard activation, a focus ring, live status, and reduced
motion. A successful solve fills a hidden input named `kaputt-token` and emits a
`solve` event. The server supplies a relative `ttlMs` for browser timers, so an
incorrect device clock does not block visitors. The widget resets when that timer
elapses. The server always enforces the signed expiry. Reset also cancels any workers.
After your application submits or consumes a token, call `widget.reset()`.

Labels are attributes; any you omit keep the English default. Changing an
attribute updates the visible label. Like in Cap, a label too long for one line
wraps onto a second line; keep it within two lines (about 40 characters).

```html
<kaputt-widget api-endpoint="/pow"
  label-initial="Jestem człowiekiem"
  label-verifying="Sprawdzam..."
  label-solved="Gotowe"
  label-error="Błąd. Spróbuj ponownie."
  label-wasm-disabled="Włącz WebAssembly, bez tego weryfikacja nie zadziała."
></kaputt-widget>
```

If WebAssembly is disabled or blocked (for example Safari Lockdown Mode, or a CSP
without `'wasm-unsafe-eval'`), the widget makes no request and shows `label-wasm-disabled` in its error state.
Without WebAssembly verification cannot work at all.

To add headers or credentials to the widget's `api-endpoint` requests, define a
fetch-compatible function anywhere on the page, before or after the module loads:

```js
window.KAPUTT_CUSTOM_FETCH = (url, options) =>
  fetch(url, { ...options, headers: { ...options.headers, 'x-token': 'x' } });
```

A hidden input is not a security check or required-field validation. Your form
code can call `await widget.solve()` before submitting; the server must always
call `validateToken` before the protected action.

```js
const widget = document.querySelector('kaputt-widget');
widget.addEventListener('solve', ({ detail }) => {
  console.log('Proof completed', detail.expires);
});
widget.addEventListener('error', ({ detail }) => {
  console.error(detail.message);
});
const token = await widget.solve(); // Also works without a click.
widget.reset();
```

To own the transport entirely, supply callbacks before calling `solve()`:

```js
widget.createChallenge = async signal => {
  return yourApi.createPowChallenge({ signal });
};
widget.redeemChallenge = async (proof, signal) => {
  return yourApi.redeemPowChallenge(proof, { signal });
};
```

Callbacks receive an `AbortSignal`. Forward it to your transport so resets and
disconnects cancel requests. `solve()` resolves to the access token, rejects on
failure, and shares pending work across concurrent callers. Other events are
`progress` (`detail.progress`, 0–100, completed puzzles) and `reset`. Listen on the
widget itself: its events do not bubble into the form or window.
Return the complete server responses from callbacks, including `ttlMs`.
Deploy matching server and browser versions; the browser requires that field.

For a strict same-origin CSP, allow your asset path in `script-src`, `worker-src`,
`style-src`, and `connect-src`. HashWX needs `'wasm-unsafe-eval'` in `script-src`.
The checkmark and error SVG backgrounds need `data:` in `img-src`. The widget uses
an external stylesheet; it does not require inline script or `'unsafe-eval'`.

## No widget

Use the solver directly with your own UI and transport:

```js
import { solveChallenges } from '/assets/kaputt/client.js';

const controller = new AbortController();
const challenge = await yourApi.createPowChallenge();
const proof = await solveChallenges(challenge, {
  signal: controller.signal,
  onProgress: percent => console.log(percent),
});
const result = await yourApi.redeemPowChallenge(proof);
// Submit result.token with your protected request if result.success is true.
```

With a bundler, import `solveChallenges` from `kaputt/client` and the widget from
`kaputt/widget`. Ensure the bundler preserves the module-worker and relative WASM
and CSS assets, or use the direct static mapping above. The solver uses at most
four workers, independent of browser identity or reported hardware properties.

## Storage examples

`consumeNonce(key, ttlMs)` must atomically return **boolean `true` only once** for a
key across every application instance. Keep it present for at least `ttlMs`,
rounded up if your backend uses seconds. Keys include distinct
`kaputt:challenge:` and `kaputt:access:` prefixes. The callback receives no IP,
user agent, browser properties, or token secret. Use it in both validation calls.
Use a consistent server clock across instances and a store that does not evict
live replay records under memory pressure.

### In-memory, single process

See [examples/memory.js](examples/memory.js). It is intentionally small, with lazy
expiry cleanup. Its scan is O(number of live keys) per call. It loses replay
protection on restart and is unsuitable for multiple processes. Use Redis or SQL
for shared, durable protection.

### Redis

Use Bun's built-in Redis client (`REDIS_URL`), with no client dependency:

```js
import { redis } from 'bun';

const consumeNonce = async (key, ttlMs) => {
  return await redis.send('SET', [key, '1', 'NX', 'PX', String(Math.ceil(ttlMs))]) === 'OK';
};
```

Do not implement `GET` followed by `SET`; concurrent requests would both pass.
Configure persistence to retain live replay keys through restarts if tokens
remain valid across restarts.

### MySQL

Use Bun's built-in SQL client with `DATABASE_URL=mysql://user:password@localhost:3306/app`:

```sql
CREATE TABLE kaputt_used (
  nonce_key VARBINARY(64) PRIMARY KEY,
  expires_at DATETIME NOT NULL,
  INDEX (expires_at)
) ENGINE=InnoDB;
```

```js
import { sql, SQL } from 'bun';

const consumeNonce = async (key, ttlMs) => {
  const expires = new Date(Math.ceil((Date.now() + ttlMs) / 1000) * 1000);
  try {
    await sql`
      INSERT INTO kaputt_used (nonce_key, expires_at) VALUES (${key}, ${expires})
    `;
    return true;
  } catch (error) {
    if (error instanceof SQL.MySQLError && error.errno === 1062) return false;
    throw error;
  }
};
```

The primary key makes the insert atomic. Only a duplicate-key error returns
`false`; other database errors propagate and validation returns `storage_error`.
Expiry is rounded up to whole seconds, so a replay key is never removed before
its required lifetime. Bun binds `Date` values in UTC and configures its MySQL
connections to use UTC. Periodically delete expired rows:

```js
await sql`DELETE FROM kaputt_used WHERE expires_at <= ${new Date()}`;
```

Keeping an expired row longer is safe; it only uses space. Keep application
clocks consistent across instances. MySQL `DATETIME` uses 5 bytes at second
precision.

## API

### `generateChallenge(secret, options = {})`

Returns `{ token, challenges: [{ c, d, n }], expires, ttlMs }`. `expires` is Unix
time in milliseconds; `ttlMs` is the relative lifetime for browser timers.
The signature authenticates every puzzle and its scope and expiry; validation
trusts the signed token, never client-supplied difficulty fields.

| Option | Default | Meaning |
| --- | --- | --- |
| `scope` | `''` | Server-selected action/session scope, at most 256 characters |
| `expiresMs` | `600000` | Challenge lifetime, 1–86400000 ms |
| `difficulty` | `1000000` | Approximate total expected hashes, integer 1–1000000000 |
| `count` | `4` | Puzzle count, integer 1–64 |
| `noncesPerHash` | `65536` | Nonces per generated HashWX program, integer 1–1048576 |

The total difficulty is split across puzzles as `max(1, round(difficulty / count))`.
Multiple puzzles reduce solve-time variance. Start with the default and measure
on real devices used by your visitors. Slower phones pay more wall-clock time;
lower difficulty if that is unacceptable. There is no device-based scoring.

### `validateChallenge(secret, body, options)`

`body`: `{ token, solutions: [{ nonce: '123' }] }`, in puzzle order. Nonces are
canonical unsigned decimal strings in `[0, 2^64 - 1]`, never JSON numbers.

`options`: `{ scope = '', consumeNonce, tokenTtlMs = 1200000 }`.
`consumeNonce` is required. Token TTL is 1–86400000 ms.

Returns `{ success: true, token, expires, ttlMs }` or `{ success: false, reason }`.
Malformed client input returns failure. Invalid application configuration and
WASM initialization errors throw; handle these at your HTTP boundary.

### `validateToken(secret, token, options)`

`options`: `{ scope = '', consumeNonce }` (callback required).
Returns `{ success: true }` or `{ success: false, reason }`.
It accepts only an access token, never an unsolved challenge.

Failure reasons: `invalid_body`, `invalid_token` (including wrong scope or token
purpose), `expired`, `invalid_solutions`, `invalid_solution`, `already_used`,
`storage_error`. A callback result other than literal `true` fails closed.

## Operating limits

Apply body-size limits and rate limits to your endpoints. Challenge generation is
cheap but unlimited issuance, replay submissions, and even invalid proof checks
still consume resources. Use TLS, protect the server secret, and never expose it
in browser code. Rotating the secret invalidates outstanding challenges and tokens.

PoW does not stop a determined attacker, prove humanity, or replace access
control. Attackers can outsource work, and faster hardware still has an advantage.
The library deliberately makes no promises about detecting automated browsers.

## Development

```sh
bun install --frozen-lockfile
bun test
bunx --bun playwright install chromium
bun run test:browser
bun pm pack --dry-run
```

`CHROME_PATH=/path/to/chrome bun run test:browser` can use an installed Chrome.
The browser check uses `Bun.serve` for a temporary loopback server only for tests.
It covers the real WASM worker flow, keyboard UX, Cap dimensions, one-use tokens, cancellation,
error recovery, callbacks, and same-origin CSP.

## Credits and licenses

Copyright © 2026 [dr Jacek Stypuła](https://jacekstypula.pl/phd). Licensed under the WTFPL, version 2. See [LICENSE](LICENSE).
Third-party material retains its original licenses:

- Code and styles derived from [Cap](https://github.com/tiagozip/cap):
  [Apache-2.0](vendor/COPYING.APACHE), with attribution and change notices in [NOTICE](NOTICE).
- [HashWX by tevador](https://github.com/tevador/hashwx):
  [LGPL-3.0](vendor/COPYING.LESSER). Its original WASM is shipped as a separate,
  replaceable asset, with the complete corresponding source archive, build
  instructions, and LGPL/GPL license texts in [vendor/](vendor/README.md).

WTFPL applies to kaputt's original contributions, not the third-party material.
