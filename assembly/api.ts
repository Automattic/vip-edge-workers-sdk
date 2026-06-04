// Public SDK types, host function bindings, and wire encode/decode helpers.

import { MsgpackWriter, MsgpackReader } from './msgpack';

// --- Header host functions ---

// @ts-ignore — @external is an AS-only decorator
@external("header", "get")
declare function _header_get(name_ptr: i32, name_len: i32): i64;

// @ts-ignore
@external("header", "set")
declare function _header_set(name_ptr: i32, name_len: i32, val_ptr: i32, val_len: i32): i32;

// @ts-ignore
@external("header", "append")
declare function _header_append(name_ptr: i32, name_len: i32, val_ptr: i32, val_len: i32): i32;

// @ts-ignore
@external("header", "delete")
declare function _header_delete(name_ptr: i32, name_len: i32): i32;

// @ts-ignore
@external("header", "list")
declare function _header_list(): i64;

// --- Response builder host functions ---
// `response.*` is a separate header map for the early/replacement response.
// `header.*` mutates the in-flight request (request phases) or upstream
// response (response phases); `response.*` builds the response that
// `response.respond` commits.

// @ts-ignore
@external("response", "header_set")
declare function _response_header_set(name_ptr: i32, name_len: i32, val_ptr: i32, val_len: i32): i32;

// @ts-ignore
@external("response", "header_append")
declare function _response_header_append(name_ptr: i32, name_len: i32, val_ptr: i32, val_len: i32): i32;

// @ts-ignore
@external("response", "respond")
declare function _response_respond(status: i32, body_ptr: i32, body_len: i32): i32;

// Set by `responseSend`; read by the ABI layer to decide whether to write
// a passthrough output struct or a zeroed one. Reset at the start of each
// host-invoked handler dispatch via `_resetResponseSent`.
let _responseSent: bool = false;

/** @internal */
export function _isResponseSent(): bool { return _responseSent; }

/** @internal */
export function _resetResponseSent(): void { _responseSent = false; }

// --- Public types ---

/**
 * Represents the inbound HTTP request in a request-phase handler.
 *
 * Mutate fields directly or use the helper methods to modify headers and body.
 * Call {@link respond} or {@link respondText} to short-circuit the request and
 * return a response to the client without forwarding to origin.
 *
 * Available in: {@link onClientRequest}, {@link onOriginRequest}.
 */
export class HttpRequest {
  /** HTTP method (e.g. `"GET"`, `"POST"`). */
  method: string = "";
  /** Request URI including path and query string (e.g. `"/search?q=foo"`). */
  uri: string = "";
  /** Raw request body bytes, or `null` if the request has no body. */
  body: Uint8Array | null = null;

  /**
   * Look up a request header by name (case-insensitive).
   *
   * @param name - Header name to look up.
   * @returns The header value, or `null` if not present.
   */
  getHeader(name: string): string | null {
    const nameBuf = String.UTF8.encode(asciiLower(name));
    const packed = _header_get(changetype<i32>(nameBuf), nameBuf.byteLength);
    if (packed < 0) return null;
    // @ts-ignore — i32() is an AS truncation cast; >>> is valid on i64 in AS
    const ptr = i32(packed >>> 32);
    // @ts-ignore
    const len = i32(packed & 0xffffffff);
    return String.UTF8.decodeUnsafe(ptr, len);
  }

  /**
   * Return all headers as `[name, value]` pairs, preserving order and duplicates.
   *
   * Materialises the full header list via a host call. Use {@link getHeader}
   * for single-key lookups.
   *
   * @returns An array of `[name, value]` pairs. Names are lowercase.
   */
  getHeaders(): string[][] {
    const packed = _header_list();
    if (packed < 0) return [];
    // @ts-ignore
    const ptr = i32(packed >>> 32);
    // @ts-ignore
    const len = i32(packed & 0xffffffff);
    const r = new MsgpackReader(<usize>ptr, <usize>len);
    return r.readStrPairArray();
  }

  /**
   * Set a request header. Replaces all existing values for the same name
   * (case-insensitive).
   *
   * @param name - Header name (ASCII only, max 1 KiB).
   * @param value - Header value (max 64 KiB).
   * @throws If the name or value is invalid or exceeds the host-enforced size limits.
   */
  setHeader(name: string, value: string): void {
    headerSet(name, value);
  }

  /**
   * Remove all request headers with the given name (case-insensitive).
   * No-op if the header is not present.
   *
   * @param name - Header name to remove.
   */
  removeHeader(name: string): void {
    const nameBuf = String.UTF8.encode(asciiLower(name));
    _header_delete(changetype<i32>(nameBuf), nameBuf.byteLength);
  }

  /**
   * Append a value for `name` without removing existing values.
   * Use this for headers that legitimately repeat, such as `Cookie`.
   *
   * @param name - Header name (ASCII only, max 1 KiB).
   * @param value - Header value to append (max 64 KiB).
   * @throws If the name or value is invalid or exceeds the host-enforced size limits.
   */
  appendHeader(name: string, value: string): void {
    headerAppend(name, value);
  }

  /**
   * Decode the request body as a UTF-8 string.
   *
   * @returns The decoded string, or `null` if the body is absent.
   */
  text(): string | null {
    return decodeBodyText(this.body);
  }

  /**
   * Return the raw body bytes. Mirrors the WHATWG `Request.bytes()` name.
   *
   * @returns The body as a `Uint8Array`, or `null` if absent.
   */
  bytes(): Uint8Array | null {
    return this.body;
  }

  /**
   * UTF-8 encode `text` and store it as the request body.
   * Pass `null` to clear the body.
   *
   * @param text - String to encode, or `null` to clear.
   */
  setBodyText(text: string | null): void {
    this.body = encodeBodyText(text);
  }

  /**
   * Short-circuit the request: return a response to the client without
   * forwarding to origin.
   *
   * Headers must be supplied explicitly — request headers are not echoed
   * onto the early response. The host adds `content-length` automatically
   * and strips hop-by-hop headers; do not set those yourself.
   *
   * Return from the handler immediately after calling this. If you call it
   * again, the later call's `status` and `body` replace the earlier one's,
   * but accumulated `headers` from prior calls persist.
   *
   * @param status - HTTP status code (100–599).
   * @param body - Raw response body bytes. Defaults to no body.
   * @param headers - Response headers as `[name, value]` pairs.
   */
  respond(status: u16, body: Uint8Array | null = null, headers: string[][] = []): void {
    for (let i = 0; i < headers.length; i++) {
      responseHeaderSet(headers[i][0], headers[i][1]);
    }
    responseSend(status, body);
  }

  /**
   * Short-circuit the request with a plain-text body. Convenience wrapper
   * around {@link respond} that UTF-8 encodes `body`.
   *
   * @param status - HTTP status code (100–599).
   * @param body - Response body string. Defaults to no body.
   * @param headers - Response headers as `[name, value]` pairs.
   */
  respondText(status: u16, body: string | null = null, headers: string[][] = []): void {
    this.respond(status, encodeBodyText(body), headers);
  }

  /**
   * Instruct the host to skip bot-protection and security challenge handling
   * for this request.
   */
  bypassChallenge(): void {
    this.setHeader("x-bypass-challenge", "1");
  }

  /**
   * Instruct the host to present a bot-protection security challenge for
   * this request, even if it would not otherwise be challenged.
   */
  forceChallenge(): void {
    this.setHeader("x-force-challenge", "1");
  }

  /** @internal */
  pack(): ArrayBuffer {
    const w = new MsgpackWriter();
    w.writeArray(2);
    w.writeStr(this.method);
    w.writeStr(this.uri);
    return w.toArrayBuffer();
  }

  /** @internal */
  static unpack(base: usize, len: usize): HttpRequest {
    const r = new MsgpackReader(base, len);
    const req = new HttpRequest();
    r.readArraySize(); // 2
    req.method = r.readStr();
    req.uri = r.readStr();
    return req;
  }
}

/**
 * Represents an HTTP response — either a proxy response in a response-phase
 * handler, or the result of an outbound {@link fetch} call.
 *
 * In response phases, mutate fields or use the helpers to modify what gets
 * sent to the client. For {@link fetch} results, fields are read-only in
 * practice — the host does not observe mutations on them.
 *
 * Available in: {@link onClientResponse}, {@link onOriginResponse}, and as
 * the return value of {@link fetch}.
 */
export class HttpResponse {
  /** HTTP status code. `0` on a transport-level error from {@link fetch}. */
  status: u16 = 0;
  /** Raw response body bytes, or `null` if the response has no body. */
  body: Uint8Array | null = null;
  // Fetch responses carry headers in the msgpack payload; proxy responses use host functions.
  private _fromFetch: bool = false;
  private _fetchHeaders: string[][] = [];

  /**
   * Set by {@link fetch} when the host could not complete the outbound
   * request. Always `null` for proxy responses.
   *
   * Possible values: `timeout`, `too_many_inflight`, `request_too_large`,
   * `response_too_large`, `body_read`, `transport`, `phase_not_allowed`.
   *
   * Check {@link isError} before reading this field.
   */
  errorKind: string | null = null;

  /**
   * Human-readable detail accompanying {@link errorKind}. Only present
   * when `errorKind` is non-null.
   */
  errorMessage: string | null = null;

  /**
   * Whether this response represents a host-level transport failure.
   * Always `false` for proxy responses.
   *
   * @returns `true` if {@link errorKind} is set.
   */
  isError(): bool {
    return this.errorKind !== null;
  }

  /**
   * Look up a response header by name (case-insensitive).
   *
   * @param name - Header name to look up.
   * @returns The header value, or `null` if not present.
   */
  getHeader(name: string): string | null {
    if (this._fromFetch) {
      const lower = asciiLower(name);
      for (let i = 0; i < this._fetchHeaders.length; i++) {
        if (this._fetchHeaders[i][0] == lower) return this._fetchHeaders[i][1];
      }
      return null;
    }
    const nameBuf = String.UTF8.encode(asciiLower(name));
    const packed = _header_get(changetype<i32>(nameBuf), nameBuf.byteLength);
    if (packed < 0) return null;
    // @ts-ignore
    const ptr = i32(packed >>> 32);
    // @ts-ignore
    const len = i32(packed & 0xffffffff);
    return String.UTF8.decodeUnsafe(ptr, len);
  }

  /**
   * Return all headers as `[name, value]` pairs, preserving order and duplicates.
   *
   * For proxy responses, materialises the full header list via a host call.
   * Use {@link getHeader} for single-key lookups.
   *
   * @returns An array of `[name, value]` pairs. Names are lowercase.
   */
  getHeaders(): string[][] {
    if (this._fromFetch) return this._fetchHeaders.slice();
    const packed = _header_list();
    if (packed < 0) return [];
    // @ts-ignore
    const ptr = i32(packed >>> 32);
    // @ts-ignore
    const len = i32(packed & 0xffffffff);
    const r = new MsgpackReader(<usize>ptr, <usize>len);
    return r.readStrPairArray();
  }

  /**
   * Set a response header. Replaces all existing values for the same name
   * (case-insensitive).
   *
   * @param name - Header name (ASCII only, max 1 KiB).
   * @param value - Header value (max 64 KiB).
   * @throws If the name or value is invalid or exceeds the host-enforced size limits.
   */
  setHeader(name: string, value: string): void {
    headerSet(name, value);
  }

  /**
   * Remove all response headers with the given name (case-insensitive).
   * No-op if the header is not present.
   *
   * @param name - Header name to remove.
   */
  removeHeader(name: string): void {
    const nameBuf = String.UTF8.encode(asciiLower(name));
    _header_delete(changetype<i32>(nameBuf), nameBuf.byteLength);
  }

  /**
   * Append a value for `name` without removing existing values.
   * Use this for headers that legitimately repeat, such as `Set-Cookie`.
   *
   * @param name - Header name (ASCII only, max 1 KiB).
   * @param value - Header value to append (max 64 KiB).
   * @throws If the name or value is invalid or exceeds the host-enforced size limits.
   */
  appendHeader(name: string, value: string): void {
    headerAppend(name, value);
  }

  /**
   * Whether the response status is in the 2xx success range.
   *
   * @returns `true` if `status` is 200–299 inclusive.
   */
  get ok(): bool {
    return this.status >= 200 && this.status < 300;
  }

  /**
   * Decode the response body as a UTF-8 string.
   *
   * @returns The decoded string, or `null` if the body is absent.
   */
  text(): string | null {
    return decodeBodyText(this.body);
  }

  /**
   * Return the raw body bytes. Mirrors the WHATWG `Response.bytes()` name.
   *
   * @returns The body as a `Uint8Array`, or `null` if absent.
   */
  bytes(): Uint8Array | null {
    return this.body;
  }

  /**
   * UTF-8 encode `text` and store it as the response body.
   * Pass `null` to clear the body.
   *
   * @param text - String to encode, or `null` to clear.
   */
  setBodyText(text: string | null): void {
    this.body = encodeBodyText(text);
  }

  /**
   * Override the `Cache-Control` header to specify custom cache behaviour
   * for this response.
   *
   * @param value - Replacement `Cache-Control` value (e.g. `"public, max-age=60"`).
   */
  setCacheControl(value: string): void {
    this.setHeader("cache-control", value);
    this.setHeader("x-original-cache-control", value);
  }

  /** @internal */
  pack(): ArrayBuffer {
    const w = new MsgpackWriter();
    w.writeArray(1);
    w.writeUint16(this.status);
    return w.toArrayBuffer();
  }

  /** @internal */
  static unpack(base: usize, len: usize): HttpResponse {
    const r = new MsgpackReader(base, len);
    const resp = new HttpResponse();
    r.readArraySize(); // 1
    resp.status = r.readUint16();
    return resp;
  }

  /** @internal */
  static unpackFetch(base: usize, len: usize): HttpResponse {
    const r = new MsgpackReader(base, len);
    const resp = new HttpResponse();
    r.readArraySize();
    resp.status = r.readUint16();
    resp._fetchHeaders = r.readStrPairArray();
    resp.errorKind = r.readStrOrNil();
    resp.errorMessage = r.readStrOrNil();
    resp._fromFetch = true;
    return resp;
  }
}

// --- Handler registration ---

/** Handler function signature for request-phase callbacks. */
export type RequestHandler = (req: HttpRequest) => void;
/** Handler function signature for response-phase callbacks. */
export type ResponseHandler = (resp: HttpResponse) => void;

export let _onClientRequest: RequestHandler | null = null;
export let _onOriginRequest: RequestHandler | null = null;
export let _onClientResponse: ResponseHandler | null = null;
export let _onOriginResponse: ResponseHandler | null = null;

/**
 * Register a handler for the **client-request** phase.
 *
 * Runs on every request before the cache lookup. This is the only phase
 * in which {@link fetch} may be called. Call
 * {@link HttpRequest.respond} / {@link HttpRequest.respondText} inside the
 * handler to return an early response without hitting origin.
 *
 * @param handler - Function that receives and may mutate the {@link HttpRequest}.
 */
export function onClientRequest(handler: RequestHandler): void {
  _onClientRequest = handler;
}

/**
 * Register a handler for the **origin-request** phase.
 *
 * Runs on a cache miss, after the client-request phase and before the
 * request is forwarded to origin. Not invoked on cache hits.
 *
 * @param handler - Function that receives and may mutate the {@link HttpRequest}.
 */
export function onOriginRequest(handler: RequestHandler): void {
  _onOriginRequest = handler;
}

/**
 * Register a handler for the **client-response** phase.
 *
 * Runs after the cache lookup (hit or miss), before the response is sent
 * to the client.
 *
 * @param handler - Function that receives and may mutate the {@link HttpResponse}.
 */
export function onClientResponse(handler: ResponseHandler): void {
  _onClientResponse = handler;
}

/**
 * Register a handler for the **origin-response** phase.
 *
 * Runs on a cache miss after the origin responds, before the response is
 * stored in cache and passed to the client-response phase.
 *
 * @param handler - Function that receives and may mutate the {@link HttpResponse}.
 */
export function onOriginResponse(handler: ResponseHandler): void {
  _onOriginResponse = handler;
}

// --- Helpers ---

function encodeBodyText(text: string | null): Uint8Array | null {
  if (text === null) return null;
  return Uint8Array.wrap(String.UTF8.encode(text));
}

function decodeBodyText(body: Uint8Array | null): string | null {
  if (body === null) return null;
  return String.UTF8.decode(body.buffer);
}

// ASCII-only lowercase — header names are always ASCII.
// Avoids pulling in the full Unicode case-folding tables from String#toLowerCase.
// Fast path: returns the original string when already all-lowercase (the common case —
// setHeader normalises on every write, so lookups usually arrive pre-normalised).
function asciiLower(s: string): string {
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      let out = "";
      for (let j = 0; j < len; j++) {
        const d = s.charCodeAt(j);
        out += String.fromCharCode(d >= 65 && d <= 90 ? d | 32 : d);
      }
      return out;
    }
  }
  return s;
}

// Shared header-set logic used by both HttpRequest.setHeader and HttpResponse.setHeader.
function headerSet(name: string, value: string): void {
  const nameBuf = String.UTF8.encode(asciiLower(name));
  const valBuf = String.UTF8.encode(value);
  const rc = _header_set(changetype<i32>(nameBuf), nameBuf.byteLength, changetype<i32>(valBuf), valBuf.byteLength);
  if (rc === 1) throw new Error("setHeader: invalid header name '" + name + "'");
  if (rc === 2) throw new Error("setHeader: invalid header value for '" + name + "'");
  if (rc === 3) throw new Error("setHeader: header name too large (max 1024 bytes)");
  if (rc === 4) throw new Error("setHeader: header value too large (max 65536 bytes)");
}

// Shared header-append logic used by both HttpRequest.appendHeader and HttpResponse.appendHeader.
function headerAppend(name: string, value: string): void {
  const nameBuf = String.UTF8.encode(asciiLower(name));
  const valBuf = String.UTF8.encode(value);
  const rc = _header_append(changetype<i32>(nameBuf), nameBuf.byteLength, changetype<i32>(valBuf), valBuf.byteLength);
  if (rc === 1) throw new Error("appendHeader: invalid header name '" + name + "'");
  if (rc === 2) throw new Error("appendHeader: invalid header value for '" + name + "'");
  if (rc === 3) throw new Error("appendHeader: header name too large (max 1024 bytes)");
  if (rc === 4) throw new Error("appendHeader: header value too large (max 65536 bytes)");
}

// Set a header on the response builder used by `responseSend`.
function responseHeaderSet(name: string, value: string): void {
  const nameBuf = String.UTF8.encode(asciiLower(name));
  const valBuf = String.UTF8.encode(value);
  const rc = _response_header_set(changetype<i32>(nameBuf), nameBuf.byteLength, changetype<i32>(valBuf), valBuf.byteLength);
  if (rc === 1) throw new Error("respond: invalid header name '" + name + "'");
  if (rc === 2) throw new Error("respond: invalid header value for '" + name + "'");
  if (rc === 3) throw new Error("respond: header name too large (max 1024 bytes)");
  if (rc === 4) throw new Error("respond: header value too large (max 65536 bytes)");
}

// Commit the response builder. Status + body are last-write-wins across
// repeated calls; accumulated `responseHeaderSet` calls persist.
function responseSend(status: u16, body: Uint8Array | null): void {
  const rc = _response_respond(
    <i32>status,
    body !== null ? <i32>body.dataStart : 0,
    body !== null ? body.byteLength : 0,
  );
  if (rc === 1) throw new Error("respond: status out of HTTP range (100-599)");
  if (rc === 2) throw new Error("respond: body too large");
  _responseSent = true;
}

// --- Wire encode/decode (used by ABI layer in index.ts and by fetch below) ---

export function packRequest(req: HttpRequest): ArrayBuffer { return req.pack(); }
export function unpackRequest(base: usize, len: usize): HttpRequest { return HttpRequest.unpack(base, len); }
export function packResponse(resp: HttpResponse): ArrayBuffer { return resp.pack(); }
export function unpackResponse(base: usize, len: usize): HttpResponse { return HttpResponse.unpack(base, len); }

function packFetchRequest(method: string, url: string, headers: string[][]): ArrayBuffer {
  const w = new MsgpackWriter();
  w.writeArray(3);
  w.writeStr(method);
  w.writeStr(url);
  w.writeStrPairArray(headers);
  return w.toArrayBuffer();
}

function unpackFetchResponse(base: usize, len: usize): HttpResponse { return HttpResponse.unpackFetch(base, len); }

// --- fetch (host call) ---

// @ts-ignore — @external is an AS-only decorator; TypeScript does not allow decorators on declare function
@external("env", "fetch")
declare function hostFetch(meta_ptr: i32, meta_len: i32, body_ptr: i32, body_len: i32): i64;

/**
 * Make an outbound HTTP request from the guest. Synchronous from the guest's
 * perspective — the host suspends execution while its async fetch runs.
 *
 * **Only available in the client-request phase.** Calling it from any other
 * phase returns an {@link HttpResponse} with {@link HttpResponse.errorKind}
 * set to `"phase_not_allowed"`.
 *
 * Errors are surfaced via fields, not exceptions. Always check
 * {@link HttpResponse.isError} before reading the response body.
 *
 * Host-enforced limits: 2 s end-to-end timeout · 10 MiB request body ·
 * 10 MiB response body · per-worker concurrency cap (FIFO queue).
 *
 * @param url - Fully-qualified URL to request.
 * @param method - HTTP method. Defaults to `"GET"`.
 * @param headers - Request headers as `[name, value]` pairs.
 * @param body - Request body bytes, or `null` for no body.
 * @returns An {@link HttpResponse}. On transport failure `status` is `0` and
 *   {@link HttpResponse.errorKind} / {@link HttpResponse.errorMessage} are set.
 */
export function fetch(
  url: string,
  method: string = "GET",
  headers: string[][] = [],
  body: Uint8Array | null = null,
): HttpResponse {
  const metaBuf = packFetchRequest(method, url, headers);

  const packed = hostFetch(
    changetype<i32>(metaBuf), metaBuf.byteLength,
    body !== null ? <i32>body.dataStart : 0,
    body !== null ? body.byteLength : 0,
  );

  // packed → (buf_ptr << 32) | total_len — same convention as kv.get, header.list, etc.
  // Buffer layout: [u32 meta_len][meta bytes][u32 body_len][body bytes]
  // @ts-ignore — i32() is an AS truncation cast; >>> is valid on i64 in AS
  const bufPtr = <usize>i32(packed >>> 32);
  const metaLen = load<u32>(bufPtr);
  const resp = unpackFetchResponse(bufPtr + 4, <usize>metaLen);
  const bodyOff = <usize>4 + <usize>metaLen;
  const bodyLen = load<u32>(bufPtr + bodyOff);
  if (bodyLen > 0) {
    const respBody = new Uint8Array(<i32>bodyLen);
    memory.copy(respBody.dataStart, bufPtr + bodyOff + 4, <usize>bodyLen);
    resp.body = respBody;
  }
  return resp;
}

// --- KV store (host calls) ---

// @ts-ignore
@external("kv", "get")
declare function kv_get(key_ptr: i32, key_len: i32): i64;

// @ts-ignore
@external("kv", "set")
declare function kv_set(key_ptr: i32, key_len: i32, val_ptr: i32, val_len: i32): i32;

// @ts-ignore
@external("kv", "delete")
declare function kv_delete(key_ptr: i32, key_len: i32): i32;

// @ts-ignore
@external("kv", "counter_get")
declare function kv_counter_get(key_ptr: i32, key_len: i32): i64;

// @ts-ignore
@external("kv", "counter_set")
declare function kv_counter_set(key_ptr: i32, key_len: i32, value: i64): i32;

// @ts-ignore
@external("kv", "incr")
declare function kv_incr(key_ptr: i32, key_len: i32, delta: i64): i64;

// @ts-ignore
@external("kv", "rate_register")
declare function kv_rate_register(name_ptr: i32, name_len: i32, rps: i32): i32;

// @ts-ignore
@external("kv", "rate_check")
declare function kv_rate_check(name_ptr: i32, name_len: i32, key_ptr: i32, key_len: i32): i32;

/**
 * Shared key-value store backed by the host runtime.
 *
 * The store has two key types that share the same keyspace:
 * - **Bytes keys** — arbitrary binary values up to 10 KiB, accessed via
 *   {@link get} / {@link set} / {@link getText} / {@link setText}.
 * - **Counter keys** — 64-bit signed integers, accessed via
 *   {@link counterGet} / {@link counterSet} / {@link incr}.
 *
 * A key holds either bytes or a counter, never both. {@link set} on a counter
 * key is allowed — it overwrites the key as bytes. Using a counter accessor
 * ({@link incr}, {@link counterGet}, {@link counterSet}) on a bytes key throws.
 * {@link del} removes either type.
 *
 * Keys are capped at 64 bytes (UTF-8 encoded). Entries are subject to
 * site-wide LRU eviction; evicted counters reset to `0` on next access.
 */
export namespace KV {
  /**
   * Retrieve a bytes value by key.
   *
   * @param key - Key to look up (max 64 bytes UTF-8).
   * @returns The value as a `Uint8Array`, `null` if the key is absent or
   *   holds a counter, or a zero-length array if the key exists with an
   *   empty value.
   */
  export function get(key: string): Uint8Array | null {
    const keyBuf = String.UTF8.encode(key);
    const packed = kv_get(changetype<i32>(keyBuf), keyBuf.byteLength);
    if (packed < 0) return null;
    // @ts-ignore — i32() is an AS truncation cast; >>> is valid on i64 in AS
    const ptr = i32(packed >>> 32);
    // @ts-ignore
    const len = i32(packed & 0xffffffff);
    const result = new Uint8Array(len);
    if (len > 0) memory.copy(result.dataStart, ptr, len);
    return result;
  }

  /**
   * Store a bytes value under `key`.
   *
   * @param key - Key (max 64 bytes UTF-8).
   * @param value - Value to store (max 10 KiB).
   * @throws If the key exceeds 64 bytes or the value exceeds 10 KiB.
   */
  export function set(key: string, value: Uint8Array): void {
    const keyBuf = String.UTF8.encode(key);
    const rc = kv_set(
      changetype<i32>(keyBuf), keyBuf.byteLength,
      <i32>value.dataStart, value.byteLength,
    );
    if (rc === 1) throw new Error("kv.set: key too large (max 64 bytes)");
    if (rc === 2) throw new Error("kv.set: value too large (max 10 KiB)");
  }

  /**
   * Delete a key. No-op if the key is absent. Works on both bytes and
   * counter keys.
   *
   * @param key - Key to delete.
   */
  export function del(key: string): void {
    const keyBuf = String.UTF8.encode(key);
    kv_delete(changetype<i32>(keyBuf), keyBuf.byteLength);
  }

  /**
   * Read a counter value. Returns `0` if the key is absent (counters are
   * implicitly zero before first write).
   *
   * @param key - Counter key (max 64 bytes UTF-8).
   * @returns Current counter value.
   * @throws If the key exists and holds a bytes value, not a counter.
   */
  export function counterGet(key: string): i64 {
    const keyBuf = String.UTF8.encode(key);
    const val = kv_counter_get(changetype<i32>(keyBuf), keyBuf.byteLength);
    if (val === i64.MIN_VALUE) throw new Error("kv.counterGet: key '" + key + "' holds bytes, not a counter");
    return val;
  }

  /**
   * Set a counter to an absolute value, overwriting the previous value.
   *
   * @param key - Counter key (max 64 bytes UTF-8).
   * @param value - Value to store.
   * @throws If the key exceeds 64 bytes, or if the key holds a bytes value.
   */
  export function counterSet(key: string, value: i64): void {
    const keyBuf = String.UTF8.encode(key);
    const rc = kv_counter_set(changetype<i32>(keyBuf), keyBuf.byteLength, value);
    if (rc === 1) throw new Error("kv.counterSet: key too large (max 64 bytes)");
    if (rc === 2) throw new Error("kv.counterSet: key '" + key + "' holds bytes, not a counter");
  }

  /**
   * Atomically add `delta` to a counter and return the new value. The
   * counter is initialised to `0` before the add if it does not exist.
   *
   * @param key - Counter key (max 64 bytes UTF-8).
   * @param delta - Amount to add. Use a negative value to decrement.
   *   Defaults to `1`.
   * @returns New counter value after the add.
   * @throws If the key holds a bytes value, not a counter.
   */
  // @ts-ignore — AS allows integer literals as i64 defaults; TypeScript requires bigint suffix (1n)
  export function incr(key: string, delta: i64 = 1): i64 {
    const keyBuf = String.UTF8.encode(key);
    const val = kv_incr(changetype<i32>(keyBuf), keyBuf.byteLength, delta);
    if (val === i64.MIN_VALUE) throw new Error("kv.incr: key '" + key + "' holds bytes, not a counter");
    return val;
  }

  /**
   * Convenience: retrieve a bytes value and decode it as a UTF-8 string.
   *
   * @param key - Key to look up.
   * @returns The value as a string, or `null` if the key is absent.
   */
  export function getText(key: string): string | null {
    const bytes = KV.get(key);
    if (bytes === null) return null;
    return String.UTF8.decode(bytes.buffer);
  }

  /**
   * Convenience: UTF-8 encode `value` and store it as a bytes value.
   *
   * @param key - Key (max 64 bytes UTF-8).
   * @param value - String to encode and store.
   */
  export function setText(key: string, value: string): void {
    KV.set(key, Uint8Array.wrap(String.UTF8.encode(value)));
  }
}

/**
 * Token-bucket rate limiter backed by the host runtime.
 *
 * Call {@link register} once per limiter name (safe to call on every request —
 * it is a no-op if the limiter already exists), then call {@link check} on
 * each request to test the limit.
 *
 * The `rps` quota is fixed at the first {@link register} call for a given
 * name. Subsequent calls with the same name but a different `rps` are
 * silently ignored by the host.
 *
 * The site-wide limit is 1 000 named limiters.
 */
export namespace RateLimit {
  /**
   * Register a named rate limiter. Idempotent — safe to call at the top of
   * every handler. The `rps` value is locked in on the first call; later
   * calls with the same name are no-ops regardless of `rps`.
   *
   * @param name - Limiter name (max 64 bytes UTF-8).
   * @param rps - Allowed requests per second (must be > 0).
   * @throws If the name exceeds 64 bytes, `rps` is ≤ 0, or the site-wide
   *   limiter quota (1 000) is exceeded.
   */
  export function register(name: string, rps: i32): void {
    const nameBuf = String.UTF8.encode(name);
    const rc = kv_rate_register(changetype<i32>(nameBuf), nameBuf.byteLength, rps);
    if (rc === 1) throw new Error("RateLimit.register: name too large");
    if (rc === 2) throw new Error("RateLimit.register: rps must be > 0");
    if (rc === 3) throw new Error("RateLimit.register: too many limiters (site limit: 1000)");
  }

  /**
   * Test whether a request identified by `key` is within the rate limit.
   * Returns `false` when the limit is exceeded — the caller should respond
   * with HTTP 429.
   *
   * **Choose the key carefully.** Each unique key value gets its own token
   * bucket, so a key that an attacker can enumerate freely (e.g. `req.uri`
   * with arbitrary query strings, or any user-supplied value) lets them
   * create unlimited buckets and bypass the limit entirely. Good keys are
   * things an attacker cannot cheaply vary: client IP
   * (`req.getHeader("x-forwarded-for")`), authenticated user ID, or a
   * normalised path prefix with the query string stripped
   * (`req.uri.split("?")[0]`).
   *
   * @param name - Limiter name (must have been passed to {@link register}).
   * @param key - Per-request bucket key.
   * @returns `true` if the request is allowed; `false` if it is rate-limited.
   * @throws If the limiter has not been registered — misconfiguration fails
   *   loudly rather than silently allowing all traffic.
   */
  export function check(name: string, key: string): bool {
    const nameBuf = String.UTF8.encode(name);
    const keyBuf = String.UTF8.encode(key);
    const rc = kv_rate_check(
      changetype<i32>(nameBuf), nameBuf.byteLength,
      changetype<i32>(keyBuf), keyBuf.byteLength,
    );
    if (rc === -1) throw new Error("RateLimit.check: unknown limiter '" + name + "' — call register() first");
    return rc === 1;
  }
}

// --- env (host call) ---

// @ts-ignore
@external("env", "env_get")
declare function envGet(name_ptr: i32, name_len: i32): i64;

/**
 * Look up an environment variable by name.
 *
 * Environment variables are provided by the host at worker startup and are
 * read-only. They are suitable for secrets (API keys, tokens) and
 * per-environment configuration.
 *
 * @param name - Variable name.
 * @returns The variable value, or `null` if the variable is not set.
 */
export function getenv(name: string): string | null {
  const buf = String.UTF8.encode(name);
  const packed = envGet(changetype<i32>(buf), buf.byteLength);
  if (packed < 0) return null;
  // @ts-ignore — i32() is an AS truncation cast; >>> is valid on i64 in AS
  const ptr = i32(packed >>> 32);
  // @ts-ignore
  const len = i32(packed & 0xffffffff);
  return String.UTF8.decodeUnsafe(ptr, len);
}
