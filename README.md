# @automattic/vip-edge-workers-sdk

Edge Workers let you run code at the CDN layer — before the cache, after the cache, before the origin, after the origin — with sub-millisecond overhead on every request. This SDK gives you the building blocks to write those workers in [AssemblyScript](https://www.assemblyscript.org/), a TypeScript-flavored language that compiles directly to WebAssembly (WASM).

You write your worker as a set of handlers for whichever HTTP lifecycle phases you care about. The SDK handles all the plumbing — marshalling request and response data in and out of the WASM sandbox, managing the low-level ABI between the host runtime and your code — so you can focus on what your worker actually does: rewriting headers, short-circuiting to an early response, calling an upstream API, reading from a shared key-value store, or enforcing a rate limit.

The compiled `.wasm` binary is what you deploy. It's typically a few kilobytes, cold-starts in microseconds, and runs in strict isolation — a fresh instance per request with no shared state between tenants.

## Install

```bash
npm install @automattic/vip-edge-workers-sdk
```

## Quick start

```ts
import { onClientRequest, onClientResponse } from "@automattic/vip-edge-workers-sdk";

// Re-export the ABI symbols for each phase you handle.
// alloc is always required.
export {
  alloc,
  on_client_request,
  on_client_response,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

onClientRequest((req) => {
  if (req.url == "/healthz") {
    req.respondText(200, "ok");  // short-circuit: skip origin entirely
    return;
  }
  req.headers.set("x-edge-worker", "true");
});

onClientResponse((resp) => {
  resp.headers.set("x-served-by", "edge");
});
```

## Phases

The host invokes the worker at up to four points per request:

| Phase | Register with | ABI export | Body marker | When it runs |
| --- | --- | --- | --- | --- |
| Client request | `onClientRequest` | `on_client_request` | `client_request_body` | Before cache lookup. Only phase that can call `fetch()`. |
| Origin request | `onOriginRequest` | `on_origin_request` | `origin_request_body` | Cache miss, before forwarding to origin. |
| Client response | `onClientResponse` | `on_client_response` | `client_response_body` | After cache lookup, before sending to client. |
| Origin response | `onOriginResponse` | `on_origin_response` | `origin_response_body` | Cache miss, after origin responds. |

Only re-export the ABI symbols for phases your worker handles. `alloc` is always required. Re-export a body marker only when that phase needs the body buffered (see [Body access](#body-access)).

## Phase isolation

Each phase handler runs as an **isolated invocation**. The host marshals the request (or response) into your worker, runs the one handler, and marshals the result back out — then repeats, from a clean slate, for the next phase. Two consequences trip people up:

**1. Module state does not survive between phases.** A module-level variable set in one handler is back at its initial value by the time the next phase runs. This is the single most common mistake — it looks correct and compiles cleanly, but the flag is always false:

```ts
// BROKEN — `tag` is not shared across phases; it resets before onClientResponse runs.
let tag = false;
onClientRequest((req) => { tag = req.url.includes("debug"); });
onClientResponse((resp) => { if (tag) resp.headers.set("x-debug", "1"); }); // never fires
```

### Sharing data across phases

| You want to… | Do this |
| --- | --- |
| Carry a value between two **request** phases (`onClientRequest` → `onOriginRequest`) | Mutate the request itself — e.g. `req.headers.set("x-my-flag", "1")`. Request mutations are marshaled forward to the next request phase (this is also how you change what origin sees). |
| Share data across **requests** | Use [`KV`](#kv) — the only store that persists beyond a single request. |

## API

### Registration

```ts
onClientRequest((req: Request) => void): void
onOriginRequest((req: Request) => void): void
onClientResponse((resp: Response) => void): void
onOriginResponse((resp: Response) => void): void
```

Mutate `req` / `resp` in place. In request phases, call `req.respondWith()` or `req.respondText()` to return an early response without hitting origin or cache.

---

### Body access

By default, `req.body` and `resp.body` are `null` — the host streams the body without buffering it. To have the body populated for a given phase, add its body marker to your ABI re-export block:

```ts
import { onClientRequest } from "@automattic/vip-edge-workers-sdk";

export {
  alloc,
  on_client_request,
  client_request_body,          // ← tells the host to buffer the request body
} from "@automattic/vip-edge-workers-sdk/assembly/index";

onClientRequest((req) => {
  const body = req.text();      // populated because the marker is exported
});
```

| Phase | Marker |
| --- | --- |
| Client request | `client_request_body` |
| Origin request | `origin_request_body` |
| Client response | `client_response_body` |
| Origin response | `origin_response_body` |

The marker is a compile-time signal — its presence in the binary is what matters, not any runtime call. Workers that omit a marker pay no buffering cost for that phase.

---

### `Headers`

`Headers` is a WHATWG-style view over a message's headers, exposed as `req.headers` and `resp.headers`. It mirrors the [browser `Headers`](https://developer.mozilla.org/en-US/docs/Web/API/Headers) interface, with two deliberate departures forced by AssemblyScript: it is **not iterable** (no `for…of` / spread — use `entries()` / `keys()` / `values()`, which return arrays), and the constructor accepts only `[name, value]` pairs (`new Headers([["accept", "text/plain"]])`). Header names are normalised to lowercase, per spec.

Mutations on `req.headers` / `resp.headers` apply directly to the in-flight message. A standalone `new Headers(...)`, or the `headers` on a `fetch()` result, is backed by a local list.

```ts
onClientRequest((req) => {
  const ua = req.headers.get("user-agent") || "unknown";  // string | null
  req.headers.set("x-ua", ua);                             // replace all values
  req.headers.append("x-tag", "a");                        // add without replacing
  req.headers.delete("x-internal-token");
  if (req.headers.has("authorization")) { /* … */ }
});
```

| Method | Type | Notes |
| --- | --- | --- |
| `get(name)` | `string \| null` | Case-insensitive. On a local `Headers`, repeated values are joined with `", "`; on a live message, the host returns the first value |
| `has(name)` | `bool` | Whether the header is present |
| `set(name, value)` | `void` | Replaces **all** existing values for that name; throws on invalid name/value or size limit exceeded |
| `append(name, value)` | `void` | Appends without removing existing values — use for `Set-Cookie`, `Cookie`, `Vary`, … |
| `delete(name)` | `void` | Removes all values for that name; no-op if absent |
| `getSetCookie()` | `string[]` | All `Set-Cookie` values, one per entry |
| `entries()` | `string[][]` | All `[name, value]` pairs, order and duplicates preserved |
| `keys()` | `string[]` | All header names, in order |
| `values()` | `string[]` | All header values, in order |
| `forEach(cb)` | `void` | Calls `cb(value, name, parent)` for each header |

---

### `Request`

`Request` is your view into the incoming HTTP request. You receive it as the argument to `onClientRequest` and `onOriginRequest` handlers. Read its method, URL, headers, and body; mutate it in place to change what the upstream or origin sees; or call `respondWith()` / `respondText()` to short-circuit the entire request with an immediate reply — skipping cache and origin entirely.

The same class also appears in response phases as the **read-only view** returned by [`resp.request`](#resprequest--request-read-only): the request as it arrived at the socket corresponding to that response phase, before that socket's request handlers mutated it. On that view all setters and mutating methods throw, and `body` is always `null`.

```ts
onClientRequest((req) => {
  // Header manipulation
  const ua = req.headers.get("user-agent") || "unknown";
  req.headers.set("x-ua", ua);
  req.headers.delete("x-internal-token");

  // URL helpers: path, query parameters (parsed once, cached), cookies
  if (req.path == "/search" && req.queryParams.get("q") === null) {
    req.respondText(400, "missing q");
    return;
  }
  req.queryParams.delete("utm_source");          // rewrites req.url
  const variant = req.cookies.get("ab-variant");  // string | null

  // Short-circuit with an early response
  if (req.path == "/robots.txt") {
    req.respondText(200, "User-agent: *\nDisallow: /admin/",
      new Headers([["content-type", "text/plain"]]));
    return;
  }
});
```

| Field / method | Type | Notes |
| --- | --- | --- |
| `method` | `string` | HTTP method (`"GET"`, `"POST"`, …) |
| `url` | `string` | Request target: path and query string. (Named `url` to match WHATWG; unlike a browser `Request` this is origin-relative, not absolute.) |
| `path` | `string` | Path part of `url`, without the query string. Assigning it keeps the current query string |
| `query` | `string` | Query string without the leading `?` (e.g. `"q=foo"`), or `""` if none. Assigning it replaces the query (leading `?` optional, `""` removes it) |
| `queryParams` | `URLSearchParams` | Parsed query parameters, parsed once and cached until `url` is reassigned. Mutations write back to `url`. See [`URLSearchParams`](#urlsearchparams) |
| `cookies` | `Cookies` | Parsed `Cookie` header, cached while the header value is unchanged. See [`Cookies`](#cookies) |
| `headers` | `Headers` | Request headers; mutations apply to the in-flight request |
| `body` | `Uint8Array \| null` | Raw request body; `null` if not buffered by the host |
| `text()` | `string \| null` | UTF-8 decode of `body`; `null` if body is absent |
| `bytes()` | `Uint8Array \| null` | Alias for `body` |
| `arrayBuffer()` | `ArrayBuffer \| null` | Copy of `body` as an `ArrayBuffer`; `null` if absent |
| `setBodyText(text)` | `void` | UTF-8 encode and replace `body` |
| `respondWith(response)` | `void` | Short-circuit with a `Response` (WHATWG `FetchEvent.respondWith` shape) |
| `respondText(status, body?, headers?)` | `void` | Convenience: short-circuit with a string body (UTF-8 encoded). `headers` is a `Headers` or `null` |
| `respondRedirect(location, status?)` | `void` | Convenience: short-circuit with a redirect to `location`. `status` defaults to `302`; must be 301/302/303/307/308 |
| `bypassChallenge()` | `void` | Signal host to skip bot-protection for this request |
| `forceChallenge()` | `void` | Signal host to present a bot-protection challenge for this request, even if it would not otherwise be challenged |

> **Note:** unlike the WHATWG `fetch` API, `req.text()` / `req.bytes()` / `req.arrayBuffer()` are **synchronous** — they return the value directly, not a `Promise`. AssemblyScript has no `async`/`await`.

---

### `Response`

`Response` represents an HTTP response — whether it came from the cache, the origin, or one of your `fetch()` calls. You receive it in `onClientResponse` and `onOriginResponse` handlers, and as the return value from `fetch()`. You can also construct one with `new Response(body, init)` to pass to `req.respondWith()`. Read its status and headers; mutate them to change what the client sees; call `setCacheControl()` to override how the host caches the response.

```ts
onClientResponse((resp) => {
  resp.headers.set("x-served-by", "edge");

  if (resp.ok) {
    resp.setCacheControl("public, max-age=60");
  }
});

// Build one to short-circuit a request:
req.respondWith(new Response(null, {
  status: 302,
  headers: new Headers([["location", "/elsewhere"]]),
}));
// …or the shorthand:
req.respondWith(Response.redirect("/elsewhere"));
```

| Field / getter / method | Type | Notes |
| --- | --- | --- |
| `new Response(body?, init?)` | — | `body` is `Uint8Array \| null`; `init` is `{ status?, statusText?, headers? }` |
| `Response.redirect(location, status?)` | `Response` | Static. Empty-body response with a `Location` header. `status` defaults to `302`; throws unless 301/302/303/307/308 |
| `status` | `u16` | HTTP status code; `0` on `fetch()` transport error. Defaults to `200` for a constructed response |
| `statusText` | `string` | Advisory only — not sent on the wire by this host |
| `ok` | `bool` | `true` iff `status` is 200–299 |
| `headers` | `Headers` | Response headers |
| `request` | `Request` | Read-only, phase-specific request snapshot (response phases only; see below) |
| `body` | `Uint8Array \| null` | Raw body bytes; `null` if not buffered by the host |
| `errorKind` | `string \| null` | Transport error type; only set on `Response` values returned by `fetch()`, always `null` in response-phase handlers |
| `errorMessage` | `string \| null` | Human-readable detail when `errorKind` is set |
| `text()` | `string \| null` | UTF-8 decode of `body`; `null` if body is absent |
| `bytes()` | `Uint8Array \| null` | Alias for `body` |
| `arrayBuffer()` | `ArrayBuffer \| null` | Copy of `body` as an `ArrayBuffer`; `null` if absent |
| `setBodyText(text)` | `void` | UTF-8 encode and replace `body` |
| `isError()` | `bool` | `true` iff `errorKind` is set |
| `setCacheControl(value)` | `void` | Override the `Cache-Control` header for custom cache behaviour |

> **Note:** as with `Request`, the body accessors are **synchronous** and there is no `Response.json()` — parse `text()` with a JSON library (see the [`json`](examples/json) example).

#### `resp.request` → `Request` (read-only)

Response-phase handlers run after the request has already gone upstream, so `resp.headers` is the *response* header map. To inspect the corresponding request, use `resp.request`: a **read-only snapshot taken at that response phase's socket boundary**, before the request handlers for that socket mutated it.

```ts
onClientResponse((resp) => {
  const req = resp.request;                    // client-socket request, pre-client-handler

  if (req.method == "POST") {
    resp.setCacheControl("no-store");          // never cache POST responses
  }

  const origin = req.headers.get("origin");
  if (origin !== null && origin.endsWith(".example.com")) {
    resp.headers.set("access-control-allow-origin", origin);
  }
});
```

Semantics worth knowing:

- **`onClientResponse`: client-socket snapshot.** It shows the request as the client-facing socket received it, before `onClientRequest` handlers rewrote the URL, method, or headers.
- **`onOriginResponse`: origin-socket snapshot.** It shows the request as it reached the origin-facing socket, after client-phase/cache-path mutations but before `onOriginRequest` handlers mutated it.
- **Immutable.** Setters, `respondWith`/`respondText`, and header writes throw. To change the response, mutate `resp` directly.
- **`body` is always `null`** — the host does not retain request bodies across the upstream round-trip.
- **Free unless used.** The view is built lazily, and a worker that never touches `resp.request` compiles with no `request.*` imports at all — the host then skips taking the snapshot entirely. (Requires a runtime with `request.*` host-function support; deploy the runtime before workers that use this.)

---

### `URLSearchParams`

`URLSearchParams` is an ordered multimap of query parameters, modelled on the [browser class](https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams) with the usual AssemblyScript departures: not iterable (`keys()` / `values()` / `entries()` return arrays) and constructed only from a string. Names and values are stored decoded (`+` and `%XX` handled as `application/x-www-form-urlencoded`); `toString()` re-encodes them.

`req.queryParams` is the common way to get one. It is parsed on first access and cached until `req.url` is reassigned, so repeated `get()` calls don't re-parse. Mutating it rewrites `req.url` — handy for stripping tracking parameters or normalising query order before the cache lookup. Standalone construction is useful for form bodies and for building `fetch()` URLs:

```ts
onClientRequest((req) => {
  const page = req.queryParams.get("page") || "1";
  req.queryParams.delete("fbclid");
  req.queryParams.sort();                       // canonical order → better cache hit rate

  const form = new URLSearchParams(req.text());  // POST body, application/x-www-form-urlencoded
  const email = form.get("email");

  const q = new URLSearchParams();
  q.set("q", "café & more");                     // encoded as q=caf%C3%A9+%26+more
  fetch("https://api.example.com/search?" + q.toString());
});
```

| Member | Type | Notes |
| --- | --- | --- |
| `new URLSearchParams(init?)` | — | Parses a query string (leading `?` ignored) or form body; `null` / omitted for empty |
| `size` | `i32` | Number of parameters, duplicates included |
| `get(name)` | `string \| null` | First value, or `null` if absent. An empty value (`?flag` or `?flag=`) is `""` |
| `getAll(name)` | `string[]` | Every value for `name`, in order |
| `has(name)` | `bool` | Whether `name` is present |
| `set(name, value)` | `void` | Replace all values for `name` with one; keeps the first occurrence's position |
| `append(name, value)` | `void` | Add a pair without removing existing ones |
| `delete(name)` | `void` | Remove every `name` |
| `sort()` | `void` | Stable sort by name |
| `keys()` / `values()` / `entries()` | arrays | In order, duplicates included |
| `forEach(cb)` | `void` | Calls `cb(value, name, parent)` for each pair |
| `toString()` | `string` | `a=1&b=2`, no leading `?`; `""` when empty |

`formEncode(s)` / `formDecode(s)` — the encoder and decoder used above — are exported too, for one-off use.

---

### `Cookies`

`Cookies` is a read-only view over a `Cookie` request header. Values come back verbatim (RFC 6265 defines no encoding, so none is applied); names are case-sensitive; when a name repeats, the first occurrence wins (clients send the most-specific path first). Get one from `req.cookies` — parsed on first access and reused while the header value is unchanged — or parse a header yourself with `new Cookies(value)`.

```ts
onClientRequest((req) => {
  const session = req.cookies.get("session");   // string | null
  if (session === null && req.path.startsWith("/account/")) {
    req.respondRedirect("/login");
  }
});
```

| Member | Type | Notes |
| --- | --- | --- |
| `new Cookies(header?)` | — | Parses a `Cookie` header value such as `"a=1; b=2"`; `null` / omitted for empty |
| `size` | `i32` | Number of distinct names |
| `get(name)` | `string \| null` | Value, or `null` if absent |
| `has(name)` | `bool` | Whether `name` is present |
| `keys()` / `entries()` | arrays | Names, or `[name, value]` pairs, in header order |

To *set* cookies on a response, use `resp.headers.append("set-cookie", …)`; to read the ones a response sets, `resp.headers.getSetCookie()`.

---

### HTML rewriting (`HtmlRules`)

`HtmlRules` rewrites HTML response bodies without the bytes ever entering your worker. You declare a set of rules — CSS selector plus an action — and call `install()` once; the host runs them with [lol-html](https://github.com/cloudflare/lol-html) as the response streams to the client. The whole rule set crosses the host/guest boundary in a single call, so cost is constant no matter how many rules you add.

**Prefer this over manual body editing whenever you can.** Because the host rewrites the response as a stream, your worker never buffers the body into WASM memory: there's nothing to allocate, nothing to copy across the sandbox boundary, and **no response-size ceiling** — a multi-megabyte page rewrites the same way a small one does. Manual editing (export an `*_response_body` marker, then `text()` / `setBodyText()`) forces the host to buffer the entire body so it fits in linear memory, which is slower, costs memory proportional to the response, and is bounded by the host's buffered-body limit. Reach for the manual path only when you genuinely need to compute the change from the body's own content (something no declarative rule can express).

```ts
import { onOriginResponse, Response, HtmlRules } from "@automattic/vip-edge-workers-sdk";

export {
  alloc,
  on_origin_response,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

onOriginResponse((resp: Response): void => {
  new HtmlRules()
    .prependInside("head", '<script src="/analytics.js" defer></script>')
    .setAttr("meta[name=robots]", "content", "noindex")
    .removeAttr("a", "ping")
    .rewriteAttrRe("a[href]", "href", "^http://", "https://")  // force outbound links to https
    .remove("script[data-tracker]")
    .install();
});
```

**Phase and content-type rules:**

- Effective only in response-phase handlers (`onClientResponse` / `onOriginResponse`). Rules registered in a request phase are silently dropped.
- Applied only when the response `Content-Type` is `text/html` or `application/xhtml+xml`. JSON, images, etc. pass through untouched.
- The body never enters the worker, so **do not** export an `*_response_body` marker for this — there is nothing to buffer.

| Method | Signature | Action |
| --- | --- | --- |
| `insertBefore` | `(selector, html)` | Insert `html` immediately before each matching element |
| `insertAfter` | `(selector, html)` | Insert `html` immediately after each matching element |
| `prependInside` | `(selector, html)` | Insert `html` as the first child of each match |
| `appendInside` | `(selector, html)` | Insert `html` as the last child of each match |
| `replace` | `(selector, html)` | Replace each match (and its children) with `html` |
| `remove` | `(selector)` | Remove each match (and its children) |
| `setAttr` | `(selector, name, value)` | Set attribute `name` to `value` on each match |
| `removeAttr` | `(selector, name)` | Remove attribute `name` from each match |
| `rewriteAttrRe` | `(selector, name, pattern, template)` | Rewrite attribute `name` via `pattern.replace_all(template)` |
| `setText` | `(selector, text)` | Replace the text content of each match (HTML-escaped) |
| `install` | `() → void` | Submit the accumulated rules. Throws on any host validation error |

**Notes:**

- **Selectors** use lol-html's CSS subset — `a[href]`, `a[href^="/"]`, `div.cls`, `#id`, `header > nav`, and most position pseudo-classes.
- **`html` arguments are inserted verbatim, not escaped.** Escape any user-controlled content yourself before passing it in. `setText` is the exception — its `text` is HTML-escaped by the host.
- **`rewriteAttrRe`** uses Rust `regex` (RE2-style, no lookarounds). Templates support numbered captures (`$1`..`$9`), named captures (`${name}`), the whole match (`$0`), and `$$` for a literal `$`. The attribute is left untouched if absent or if the replacement is a no-op.
- The builder is chainable; call `install()` **once** per worker. Two `install()` calls queue two separate rule sets.
- Limits: ≤ 256 rules and ≤ 64 KiB total payload per call. `install()` throws on an oversize payload, an invalid selector, or a bad regex pattern.

---

### `fetch(url, init?) → Response`

Make an outbound HTTP request from the worker. Modelled on WHATWG [`fetch(url, init)`](https://developer.mozilla.org/en-US/docs/Web/API/fetch), but — because AssemblyScript has no `async` — it returns a `Response` **directly, not a `Promise`**. From your code's perspective it's a regular synchronous call: the host suspends the WASM instance while the request is in flight and resumes it with the response. Errors are surfaced via fields rather than a rejected promise, so always check `resp.isError()` before reading the body.

**Available in the client-request phase only.** Calling it from any other phase returns a `Response` with `errorKind` set to `"phase_not_allowed"`.

```ts
import { fetch, Headers, onClientRequest } from "@automattic/vip-edge-workers-sdk";

onClientRequest((req) => {
  if (!req.url.startsWith("/ip")) return;

  const resp = fetch("https://ifconfig.me/ip", {
    headers: new Headers([["accept", "text/plain"]]),
  });

  if (resp.isError()) {
    req.respondText(502, "fetch failed: " + resp.errorKind!);
    return;
  }

  req.respondText(resp.status, resp.text(), new Headers([["content-type", "text/plain"]]));
});
```

To send a request body:

```ts
const body = Uint8Array.wrap(String.UTF8.encode('{"key":"value"}'));
const resp = fetch("https://api.example.com/v1/data", {
  method: "POST",
  headers: new Headers([["content-type", "application/json"]]),
  body,
});
```

`init` is a `RequestInit` — an options bag you can pass as an object literal:

| `init` field | Type | Default |
| --- | --- | --- |
| `method` | `string` | `"GET"` |
| `headers` | `Headers \| null` | `null` |
| `body` | `Uint8Array \| null` | `null` |

`errorKind` values: `timeout`, `too_many_inflight`, `request_too_large`, `response_too_large`, `body_read`, `transport`, `phase_not_allowed`.

Host-enforced limits: 2 s end-to-end timeout · 10 MiB request body · 10 MiB response body · per-worker concurrency cap (FIFO queue).

---

### `KV`

`KV` is a shared, host-backed key-value store. Unlike in-memory variables in your worker code — which are wiped at the end of every request because the WASM instance is discarded — `KV` persists data across requests and is shared across all instances running on the same site. It's useful for counters, feature flags, small configuration blobs, or any value that needs to outlive a single request.

The store has two distinct modes. **Bytes** holds arbitrary values up to 10 KiB. **Counters** hold atomic 64-bit integers — useful for visit counts, quotas, or any value you need to increment safely under concurrent load. A key holds one type at a time. Counter accessors throw when a key holds bytes; byte reads treat a counter key as absent; and `set` / `setText` replace a counter with a bytes value.

Keys: max 64 bytes (UTF-8). Values: max 10 KiB. Entries are subject to site-wide LRU eviction; evicted counters reset to `0` on next access.

**Bytes store**

```ts
import { KV, onClientRequest } from "@automattic/vip-edge-workers-sdk";

// PUT reads req.text() — export client_request_body to have the host buffer it.
onClientRequest((req) => {
  if (req.method == "PUT" && req.url == "/note") {
    KV.setText("note", req.text() || "");
    req.respondText(200, "stored");
    return;
  }

  if (req.method == "GET" && req.url == "/note") {
    const note = KV.getText("note");
    req.respondText(note !== null ? 200 : 404, note || "no note stored");
    return;
  }
});
```

| Method | Signature | Notes |
| --- | --- | --- |
| `get` | `(key: string) → Uint8Array \| null` | `null` = absent or counter key; zero-length = key exists with empty value |
| `set` | `(key: string, value: Uint8Array) → void` | Replaces a counter key with bytes; throws if key > 64 B or value > 10 KiB |
| `del` | `(key: string) → void` | No-op if absent; works on both types |
| `getText` | `(key: string) → string \| null` | `get` + UTF-8 decode |
| `setText` | `(key: string, value: string) → void` | UTF-8 encode + `set`, including counter-to-bytes replacement |

**Counter store**

Atomic 64-bit integers. Absent counters read as `0` and are created on first write.

```ts
onClientRequest((req) => {
  const visits = KV.incr("visits");  // atomic +1, returns new value
  req.headers.set("x-visit-count", visits.toString());
});
```

| Method | Signature | Notes |
| --- | --- | --- |
| `counterGet` | `(key: string) → i64` | `0` if absent; throws if key holds bytes |
| `counterSet` | `(key: string, value: i64) → void` | Throws if key > 64 B or key holds bytes |
| `incr` | `(key: string, delta: i64 = 1) → i64` | Atomic add; returns new value; initialises to `0` if absent; throws if key holds bytes |

---

### `RateLimit`

`RateLimit` lets you enforce request rate limits at the edge, before a request ever reaches your origin. You define a named limiter with a target rate in requests per second, then check each incoming request against a key — typically a client IP or authenticated user ID. Each unique key gets its own independent token bucket, so the limit applies per-client rather than globally. Limiters are shared across all instances on the same site, so the rate is enforced consistently even under concurrent load.

`register` is idempotent and safe to call on every request. The `rps` value is fixed at the first `register` call; later calls with the same name are no-ops regardless of what `rps` you pass.

```ts
import { RateLimit, onClientRequest } from "@automattic/vip-edge-workers-sdk";

onClientRequest((req) => {
  if (!req.url.startsWith("/api/")) return;

  RateLimit.register("api", 50);
  const ip = req.headers.get("x-forwarded-for") || "";
  if (!RateLimit.check("api", ip)) {
    req.respondText(429, "rate limited");
    return;
  }
});
```

| Method | Signature | Notes |
| --- | --- | --- |
| `register` | `(name: string, rps: i32) → void` | Idempotent. Throws if name > 64 B, `rps` ≤ 0, or site-wide limiter quota (1000) exceeded |
| `check` | `(name: string, key: string) → bool` | `true` = allowed, `false` = rate-limited. Throws if limiter not registered |

**Choosing the key:** each unique key gets its own token bucket. Key on something an attacker cannot enumerate freely — client IP, authenticated user ID, a normalised path prefix. Never use `req.url` directly; arbitrary query strings create unlimited unique buckets and defeat the limit.

| Good | Bad |
| --- | --- |
| `req.headers.get("x-forwarded-for")` | `req.url` — query strings make every request unique |
| Authenticated user ID | Any user-supplied header or body value |
| `req.path` — path without the query string | `req.url` with arbitrary query params |

---

### `getenv(name) → string | null`

Look up a host-provided environment variable. Variables are read-only and set at worker startup. Returns `null` if not set.

Environment values are injected at runtime rather than embedded in the worker source or compiled binary. After `getenv()` returns, however, the value is an ordinary string: worker code can put it in a request, response, or log. Never place secrets in URLs or query strings; send them to trusted services in a header or body only when the integration requires it.

```ts
import { getenv, onClientRequest } from "@automattic/vip-edge-workers-sdk";

onClientRequest((req) => {
  const key = getenv("API_KEY");
  if (key !== null) req.headers.set("authorization", "Bearer " + key);
});
```

---

### Crypto

Host-executed cryptographic primitives. No hash or HMAC code lives in the WASM binary — your worker binary stays small and the host handles all crypto operations.

**HMAC-SHA256 / webhook signature verification**

```ts
import {
  getenv, onClientRequest,
  hmacSha256Str, secureCompare, hexEncode,
} from "@automattic/vip-edge-workers-sdk";

export {
  alloc, on_client_request, client_request_body,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

onClientRequest((req) => {
  const secret = getenv("WEBHOOK_SECRET");
  if (secret === null) { req.respondText(500, "not configured"); return; }

  const sig      = req.headers.get("x-hub-signature-256") || "";
  const expected = "sha256=" + hexEncode(hmacSha256Str(secret, req.text() || ""));

  const a = Uint8Array.wrap(String.UTF8.encode(sig));
  const b = Uint8Array.wrap(String.UTF8.encode(expected));
  if (!secureCompare(a, b)) { req.respondText(401, "invalid signature"); return; }
});
```

**HS256 JWT verification**

```ts
import { getenv, onClientRequest, jwtVerifyHs256 } from "@automattic/vip-edge-workers-sdk";

onClientRequest((req) => {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) { req.respondText(401, "missing token"); return; }

  const claims = jwtVerifyHs256(auth.slice(7), getenv("JWT_SECRET") || "");
  if (claims === null) { req.respondText(401, "invalid or expired token"); return; }

  // claims is the raw JSON payload — parse with json-as if you need specific fields,
  // or forward it to the origin as a header.
  req.headers.set("x-jwt-claims", claims);
});
```

| Function | Signature | Notes |
| --- | --- | --- |
| `hmacSha256` | `(key: Uint8Array, msg: Uint8Array) → Uint8Array` | 32-byte HMAC-SHA256 digest |
| `hmacSha256Str` | `(key: string, msg: string) → Uint8Array` | Convenience: UTF-8 encodes both inputs |
| `sha256` | `(msg: Uint8Array) → Uint8Array` | 32-byte SHA-256 digest |
| `secureCompare` | `(a: Uint8Array, b: Uint8Array) → bool` | Timing-attack-safe comparison; execution time depends only on input length, not content |
| `jwtVerifyHs256` | `(token: string, secret: string) → string \| null` | Verifies alg, signature, and `exp`; returns claims JSON or `null` |
| `getRandomValues` | `(array: Uint8Array) → Uint8Array` | Fills `array` with OS-sourced secure random bytes; at most 64 KiB per call |
| `hexEncode` | `(bytes: Uint8Array) → string` | Lowercase hex string (two characters per byte) |

**Secure random bytes**

```ts
import { getRandomValues, hexEncode, onClientRequest } from "@automattic/vip-edge-workers-sdk";

onClientRequest((req) => {
  const nonce = hexEncode(getRandomValues(new Uint8Array(16)));
  req.headers.set("x-request-nonce", nonce);
});
```

`getRandomValues` mirrors Web Crypto: it fills the array in place from the host's OS entropy source and throws if asked for more than 64 KiB at once. `Math.random()` also works in workers, but it is an ordinary PRNG whose output can be predicted from a few observed values, so never use it for tokens, nonces, session IDs, or keys.

`jwtVerifyHs256` validates `alg: "HS256"` strictly — RS256 / ES256 tokens return `null`. `exp` is checked against wall clock; `nbf` and `iat` are not enforced.

Secrets should come from `getenv()` so they are injected at deploy time instead of embedded in the binary. Treat the returned string as sensitive: this prevents build-time disclosure, but it does not stop worker code from transmitting the value.

---

### Parsing JSON

The SDK does not include a JSON library. Workers that need to parse structured JSON bodies add [`json-as`](https://www.npmjs.com/package/json-as) directly to their own `package.json` and pass `--transform json-as` to `asc`. Workers that don't parse JSON pay nothing — no serialization code is included in their binary.

```ts
import { JSON } from "json-as";
import { fetch, Headers, onClientRequest } from "@automattic/vip-edge-workers-sdk";

@json
class Todo {
  id: i32 = 0;
  title: string = "";
  completed: bool = false;
}

@json
class Summary {
  id: i32 = 0;
  title: string = "";
  done: bool = false;
}

onClientRequest((req) => {
  if (!req.url.startsWith("/todo/")) return;

  const resp = fetch("https://jsonplaceholder.typicode.com/todos/" + req.url.slice(6));
  if (!resp.ok) { req.respondText(resp.status, "not found"); return; }

  const todo = JSON.parse<Todo>(resp.text()!);

  const out = new Summary();
  out.id = todo.id;
  out.title = todo.title;
  out.done = todo.completed;

  req.respondText(
    200,
    JSON.stringify(out),
    new Headers([["content-type", "application/json"]]),
  );
});
```

## Building code

Your worker source is [AssemblyScript](https://www.assemblyscript.org/) — a TypeScript-flavored language that compiles to WebAssembly bytecode using `asc`, the AssemblyScript compiler. Unlike TypeScript, which transpiles to JavaScript, AssemblyScript compiles all the way down to a `.wasm` binary with no JavaScript runtime dependency. The result is a small, self-contained file that the host loads and executes directly.

One compiler flag is always required, and two are strongly recommended for release builds:

- **`--runtime stub`** uses a simple bump allocator with no garbage collector. Each request starts with a fresh heap and all memory is reclaimed when the request ends — there is nothing for a GC to manage.
- **`--optimizeLevel 3`** runs the full Binaryen optimiser. Without it, binaries are significantly larger and slower.
- **`--shrinkLevel 2`** tells the optimiser to prefer size over speed (`-Oz` equivalent) — inlines less, merges similar code. Typically cuts an additional 15–25% off the release binary.

If your worker parses JSON bodies, also add **`--transform json-as`** (see [Parsing JSON](#parsing-json)).

```js
// build.mjs
import { execFileSync } from 'child_process';
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(fileURLToPath(import.meta.url));
const nodeModules = resolve(root, 'node_modules');
const { NODE_OPTIONS: _drop, ...env } = process.env;

mkdirSync(resolve(root, 'build'), { recursive: true });

execFileSync(resolve(nodeModules, '.bin/asc'), [
  resolve(root, 'assembly/index.ts'),
  '--outFile', resolve(root, 'build/release.wasm'),
  '--runtime', 'stub',
  '--optimizeLevel', '3',
  '--shrinkLevel', '2',
  '--path', nodeModules,
], { cwd: nodeModules, env, stdio: 'inherit' });
```

Working examples under [`examples/`](examples):

| Example | What it shows |
| --- | --- |
| [`fetch`](examples/fetch) | Outbound `fetch()` — proxy a route to an external API |
| [`kv`](examples/kv) | KV bytes store + atomic counter forwarded to origin as a header |
| [`rate-limit`](examples/rate-limit) | Per-path rate limiting with `RateLimit` |
| [`json`](examples/json) | Parse a JSON API response into a typed `@json` class |
| [`html-rewrite`](examples/html-rewrite) | Declarative HTML rewriting with `HtmlRules` — anonymize outbound links via href.li |
| [`redirect`](examples/redirect) | 301 redirects — rename a path prefix and strip trailing slashes |
| [`rewrite`](examples/rewrite) | Internal rewrite — repoint host + URI before cache lookup, no client-visible redirect |
| [`headers`](examples/headers) | Override `Cache-Control` on the origin response + tag `.pdf` responses using the `resp.request` view |
| [`webhook`](examples/webhook) | HMAC-SHA256 webhook signature verification (GitHub style) |
| [`udger`](examples/udger) | Device/crawler detection via the Udger Cloud Parser API + `getenv` secret |

Run `make examples` to build all of them.

## Notes

**Bodies are opt-in.** `req.body` and `resp.body` are `null` by default; see [Body access](#body-access) to enable buffering per phase. `fetch()` response bodies are always available. Use `text()` / `bytes()` to read; `setBodyText()` to replace.

**Bodies are raw bytes** (`Uint8Array`). Use `text()` / `setBodyText()` for UTF-8 strings; `JSON.parse` (via json-as) for structured JSON; everything else (binary, compressed, …) is plain bytes.

**Headers** — accessed via `req.headers` / `resp.headers`, a WHATWG-style [`Headers`](#headers) object. `set` replaces all existing values for a name; `append` adds a value alongside existing ones (use for `Set-Cookie`, `Vary`, etc.); `get` returns the value (joining duplicates with `", "` on a local `Headers`); `entries()` returns all pairs in order. Header names are normalised to lowercase. Name limit: 1 KiB; value limit: 64 KiB — `set` and `append` throw if either is exceeded.

**Memory model (`--runtime stub`).** The stub runtime is a bump allocator — no GC, memory is never freed within a single phase invocation. Each phase invocation starts from a clean slate: no state is carried over from a prior phase, a prior request, or another worker — full isolation is guaranteed. Because nothing survives from one phase to the next, module-level variables **cannot** be used to pass data between phases — see [Phase isolation](#phase-isolation) for how to share data correctly.
