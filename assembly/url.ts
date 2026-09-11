// URL query-string and Cookie-header parsing, shared by Request and usable standalone.

const HEX_DIGITS = "0123456789ABCDEF";

function hexValue(c: u8): i32 {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

function isFormSafe(b: u8): bool {
  return (b >= 48 && b <= 57)
    || (b >= 65 && b <= 90)
    || (b >= 97 && b <= 122)
    || b == 42   // *
    || b == 45   // -
    || b == 46   // .
    || b == 95;  // _
}

/**
 * Decode an `application/x-www-form-urlencoded` component: `+` becomes a
 * space and `%XX` escapes become bytes, then the result is read as UTF-8.
 * Malformed escapes are left as-is.
 */
export function formDecode(s: string): string {
  let needsWork = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c == 37 || c == 43) { needsWork = true; break; }
  }
  if (!needsWork) return s;

  const src = String.UTF8.encode(s);
  const len = src.byteLength;
  const sp = changetype<usize>(src);
  const out = new ArrayBuffer(len);
  const op = changetype<usize>(out);
  let n = 0;
  for (let i = 0; i < len; i++) {
    let b = load<u8>(sp + i);
    if (b == 43) {
      b = 32;
    } else if (b == 37 && i + 2 < len) {
      const hi = hexValue(load<u8>(sp + i + 1));
      const lo = hexValue(load<u8>(sp + i + 2));
      if (hi >= 0 && lo >= 0) {
        b = <u8>((hi << 4) | lo);
        i += 2;
      }
    }
    store<u8>(op + n, b);
    n++;
  }
  return String.UTF8.decodeUnsafe(op, n);
}

/**
 * Encode a string as an `application/x-www-form-urlencoded` component:
 * alphanumerics and `*-._` pass through, space becomes `+`, every other
 * UTF-8 byte becomes `%XX`.
 */
export function formEncode(s: string): string {
  const src = String.UTF8.encode(s);
  const len = src.byteLength;
  const sp = changetype<usize>(src);

  let unsafe = 0;
  for (let i = 0; i < len; i++) {
    const b = load<u8>(sp + i);
    if (!isFormSafe(b) && b != 32) unsafe++;
  }
  if (unsafe == 0 && s.indexOf(" ") < 0) return s;

  const out = new ArrayBuffer(len + unsafe * 2);
  const op = changetype<usize>(out);
  let n = 0;
  for (let i = 0; i < len; i++) {
    const b = load<u8>(sp + i);
    if (isFormSafe(b)) {
      store<u8>(op + n, b);
      n++;
    } else if (b == 32) {
      store<u8>(op + n, 43);
      n++;
    } else {
      store<u8>(op + n, 37);
      store<u8>(op + n + 1, <u8>HEX_DIGITS.charCodeAt(b >> 4));
      store<u8>(op + n + 2, <u8>HEX_DIGITS.charCodeAt(b & 15));
      n += 3;
    }
  }
  return String.UTF8.decodeUnsafe(op, n);
}

/**
 * An ordered multimap of query parameters, modelled on WHATWG
 * `URLSearchParams`. Names and values are stored decoded; {@link toString}
 * re-encodes them.
 *
 * Obtain one from {@link Request.queryParams} (mutations there write back to
 * {@link Request.url}), or build one standalone: `new URLSearchParams("a=1&b=2")`
 * parses a query string or a form body, `new URLSearchParams()` starts empty.
 */
export class URLSearchParams {
  protected _names: string[] = [];
  protected _values: string[] = [];

  /**
   * @param init - Query string to parse (a leading `?` is ignored), or
   *   `null` for an empty set.
   */
  constructor(init: string | null = null) {
    if (init !== null) this._parse(init);
  }

  private _parse(query: string): void {
    let start = query.length > 0 && query.charCodeAt(0) == 63 ? 1 : 0;
    const len = query.length;
    while (start < len) {
      let end = query.indexOf("&", start);
      if (end < 0) end = len;
      if (end > start) {
        const eq = query.indexOf("=", start);
        if (eq >= 0 && eq < end) {
          this._names.push(formDecode(query.slice(start, eq)));
          this._values.push(formDecode(query.slice(eq + 1, end)));
        } else {
          this._names.push(formDecode(query.slice(start, end)));
          this._values.push("");
        }
      }
      start = end + 1;
    }
  }

  /** Hook for subclasses that mirror mutations elsewhere. */
  protected _changed(): void {}

  /** Number of parameters, duplicates included. */
  get size(): i32 {
    return this._names.length;
  }

  /** The first value for `name`, or `null` if absent. */
  get(name: string): string | null {
    const idx = this._names.indexOf(name);
    return idx < 0 ? null : this._values[idx];
  }

  /** Every value for `name`, in order. Empty if absent. */
  getAll(name: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < this._names.length; i++) {
      if (this._names[i] == name) out.push(this._values[i]);
    }
    return out;
  }

  /** Whether at least one parameter named `name` is present. */
  has(name: string): bool {
    return this._names.indexOf(name) >= 0;
  }

  /**
   * Set `name` to a single `value`, replacing all existing values. The first
   * existing occurrence keeps its position; a new name is appended.
   */
  set(name: string, value: string): void {
    const first = this._names.indexOf(name);
    if (first < 0) {
      this._names.push(name);
      this._values.push(value);
    } else {
      this._values[first] = value;
      for (let i = this._names.length - 1; i > first; i--) {
        if (this._names[i] == name) {
          this._names.splice(i, 1);
          this._values.splice(i, 1);
        }
      }
    }
    this._changed();
  }

  /** Append a `name=value` pair, keeping existing values. */
  append(name: string, value: string): void {
    this._names.push(name);
    this._values.push(value);
    this._changed();
  }

  /** Remove every parameter named `name`. No-op if absent. */
  delete(name: string): void {
    let removed = false;
    for (let i = this._names.length - 1; i >= 0; i--) {
      if (this._names[i] == name) {
        this._names.splice(i, 1);
        this._values.splice(i, 1);
        removed = true;
      }
    }
    if (removed) this._changed();
  }

  /**
   * Stable sort by name, keeping the relative order of equal names. Useful
   * for normalising a query string into a canonical cache key.
   */
  sort(): void {
    const names = this._names;
    const values = this._values;
    for (let i = 1; i < names.length; i++) {
      const n = names[i];
      const v = values[i];
      let j = i - 1;
      while (j >= 0 && names[j] > n) {
        names[j + 1] = names[j];
        values[j + 1] = values[j];
        j--;
      }
      names[j + 1] = n;
      values[j + 1] = v;
    }
    if (names.length > 1) this._changed();
  }

  /** All parameter names, in order (duplicates included). */
  keys(): string[] {
    return this._names.slice();
  }

  /** All parameter values, in order. */
  values(): string[] {
    return this._values.slice();
  }

  /** All parameters as `[name, value]` pairs, in order. */
  entries(): string[][] {
    const out: string[][] = [];
    for (let i = 0; i < this._names.length; i++) {
      out.push([this._names[i], this._values[i]]);
    }
    return out;
  }

  /** Invoke `callback(value, name, parent)` for each parameter, in order. */
  forEach(callback: (value: string, key: string, parent: URLSearchParams) => void): void {
    for (let i = 0; i < this._names.length; i++) {
      callback(this._values[i], this._names[i], this);
    }
  }

  /** Serialise as `a=1&b=2` (no leading `?`). Empty string when there are no parameters. */
  toString(): string {
    const parts: string[] = [];
    for (let i = 0; i < this._names.length; i++) {
      parts.push(formEncode(this._names[i]) + "=" + formEncode(this._values[i]));
    }
    return parts.join("&");
  }
}

/**
 * A read-only view over a `Cookie` request header. Values are returned
 * verbatim, as sent by the client (no percent-decoding; RFC 6265 defines
 * none). Names are case-sensitive. When a name repeats, the first occurrence
 * wins, matching the most-specific-path-first order clients use.
 *
 * Obtain one from {@link Request.cookies}, or parse a header yourself with
 * `new Cookies(headerValue)`.
 */
export class Cookies {
  private _names: string[] = [];
  private _map: Map<string, string> = new Map<string, string>();

  /**
   * @param header - A `Cookie` header value such as `"a=1; b=2"`, or `null`
   *   for an empty set.
   */
  constructor(header: string | null = null) {
    if (header !== null) this._parse(header);
  }

  private _parse(header: string): void {
    const pairs = header.split(";");
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      if (name.length == 0 || this._map.has(name)) continue;
      this._names.push(name);
      this._map.set(name, pair.slice(eq + 1).trim());
    }
  }

  /** Number of distinct cookie names. */
  get size(): i32 {
    return this._names.length;
  }

  /** The value of cookie `name`, or `null` if absent. */
  get(name: string): string | null {
    return this._map.has(name) ? this._map.get(name) : null;
  }

  /** Whether a cookie named `name` is present. */
  has(name: string): bool {
    return this._map.has(name);
  }

  /** All cookie names, in header order. */
  keys(): string[] {
    return this._names.slice();
  }

  /** All cookies as `[name, value]` pairs, in header order. */
  entries(): string[][] {
    const out: string[][] = [];
    for (let i = 0; i < this._names.length; i++) {
      out.push([this._names[i], this._map.get(this._names[i])]);
    }
    return out;
  }
}
