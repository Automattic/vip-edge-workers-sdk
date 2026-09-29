# CSP nonce example

Sends a `Content-Security-Policy` header with a fresh random nonce on every HTML response, and stamps the same nonce onto the page's trusted `<script>` tags so only those scripts run:

```
Content-Security-Policy: script-src 'self' 'nonce-3f9a…'; object-src 'none'; base-uri 'self'
<script data-csp-nonce>…</script>  →  <script data-csp-nonce nonce="3f9a…">…</script>
```

The nonce comes from `getRandomValues` (the host's secure random source), and the HTML is rewritten by the host as it streams via `HtmlRules`, so the body never enters the worker.

Build it with `npm install && npm run asbuild`, or `make examples` from the repo root.

## Things to consider

### Tailor the policy to your site

`POLICY` in `assembly/index.ts` is a deliberately minimal starting point. A real WordPress site almost always needs more, and a policy that is too strict breaks the page. For example:

- **Third-party scripts** must be allowed explicitly. Jetpack stats, for instance, loads from `https://stats.wp.com`, so it needs adding to `script-src`.
- **Workers created from blob URLs** (some editors and analytics tools do this) need `worker-src blob:`.
- **Other resource types** (`style-src`, `img-src`, `connect-src`, `frame-src`, …) are not restricted by this policy at all. Add them if you want to lock those down too.

Audit what your pages actually load before enforcing anything.

### Roll out with Report-Only first

Send the policy as `Content-Security-Policy-Report-Only` instead of `Content-Security-Policy` to start. Browsers then report violations in the console (or to a `report-uri` / `report-to` endpoint) without blocking anything. Switch to the enforcing header once the reports are clean.

### Use the client-response phase

The worker runs in `onClientResponse`, which runs on every request, cache hit or miss. That is what makes the nonce unique per response even when the page is served from cache. Doing this in `onOriginResponse` would bake one nonce into the cached copy and serve it to every visitor, which makes it guessable and defeats the point of a nonce.

### Only nonce scripts you trust

Stamping the nonce onto every `<script>` would also approve any script an attacker manages to inject into the page, so the example only targets:

- `script[data-csp-nonce]`: an opt-in marker. Add the attribute to trusted inline scripts at the origin (for example with the `wp_inline_script_attributes` / `wp_script_attributes` filters).
- `script[type="importmap"]`, `script[type="speculationrules"]`, `script[type="module"]`: script types WordPress core prints itself.

The `type="module"` selector is a trade-off: it also matches any injected module script. If your site doesn't use script modules, or you can mark them with `data-csp-nonce` instead, remove that selector.

### Scope the worker to HTML routes

`HtmlRules` only rewrites `text/html` and `application/xhtml+xml` responses, but the header is set on every response the worker runs on. Scope the worker's location to the pages that need the policy, and note that `headers.set` replaces any CSP header the origin already sent.

### Use a secure random source

Always generate nonces with `getRandomValues`. `Math.random()` works in workers but is a predictable PRNG, and a nonce derived from a counter or timestamp (even run through HMAC) can repeat or be guessed.
