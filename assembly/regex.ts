// Regular expressions — a JavaScript-shaped RegExp whose matching runs on the
// host. No matching code lives in the WASM binary.
//
// Pattern syntax is that of Rust's `regex` crate: Unicode-aware, but no
// lookaround or backreferences. Patterns using those fail to compile and
// throw SyntaxError here, exactly like a malformed JS regex would.
//
// Because AssemblyScript has no regex literals and cannot extend String, the
// string methods live on the RegExp instead:
//
//   str.match(re)        → re.match(str)
//   str.matchAll(re)     → re.matchAll(str)
//   str.replace(re, r)   → re.replace(str, r)
//   str.replaceAll(re,r) → re.replaceAll(str, r)
//   str.search(re)       → re.search(str)
//   str.split(re)        → re.split(str)

import { MsgpackReader } from './msgpack';

// @ts-ignore — @external is an AS-only decorator
@external("regex", "is_match")
declare function _is_match(patPtr: i32, patLen: i32, subjPtr: i32, subjLen: i32): i32;

// @ts-ignore
@external("regex", "captures")
declare function _captures(patPtr: i32, patLen: i32, subjPtr: i32, subjLen: i32, start: i32): i64;

// @ts-ignore
@external("regex", "group_names")
declare function _group_names(patPtr: i32, patLen: i32): i64;

// @ts-ignore
@external("regex", "replace")
declare function _replace(
  patPtr: i32, patLen: i32,
  subjPtr: i32, subjLen: i32,
  repPtr: i32, repLen: i32,
  limit: i32,
): i64;

const RC_NO_MATCH: i64 = -1;
const RC_BAD_PATTERN: i64 = -2;
const RC_LIMIT: i64 = -3;

function hostError(op: string, source: string, rc: i64): Error {
  if (rc == RC_BAD_PATTERN) {
    return new SyntaxError("Invalid regular expression: /" + source + "/: unsupported or malformed pattern");
  }
  if (rc == RC_LIMIT) {
    return new RangeError("RegExp." + op + ": pattern, subject or result exceeds the host's regex limits");
  }
  return new Error("RegExp." + op + ": host error " + rc.toString());
}

function utf8CharLen(lead: u8): i32 {
  if (lead < 0x80) return 1;
  if (lead < 0xe0) return 2;
  if (lead < 0xf0) return 3;
  return 4;
}

// UTF-16 index of a UTF-8 byte offset, counting forward from a known
// (byte, index) cursor so loops over a long subject stay linear overall.
function utf16IndexAt(buf: ArrayBuffer, byteOff: i32, cursorByte: i32, cursorIdx: i32): i32 {
  if (buf.byteLength == 0) return 0;
  const p = changetype<usize>(buf);
  let idx = cursorIdx;
  for (let i = cursorByte; i < byteOff; i++) {
    // @ts-ignore — load<u8> is an AS intrinsic
    const b = load<u8>(p + <usize>i);
    if ((b & 0xc0) != 0x80) idx += b >= 0xf0 ? 2 : 1;
  }
  return idx;
}

function utf8OffsetOf(s: string, utf16Idx: i32): i32 {
  if (utf16Idx <= 0) return 0;
  if (utf16Idx >= s.length) return String.UTF8.byteLength(s, false);
  return String.UTF8.byteLength(s.substring(0, utf16Idx), false);
}

function decodeSlice(buf: ArrayBuffer, start: i32, end: i32): string {
  return String.UTF8.decodeUnsafe(changetype<usize>(buf) + <usize>start, <usize>(end - start));
}

// Rewrite a JavaScript replacement template into the host's syntax.
//   $1 / $12  → ${1} / ${12}   (braced so a following letter is not eaten)
//   $<name>   → ${name}
//   $&        → ${0}
//   $$        → $$
//   any other $ is literal.  $` and $' are not supported and stay literal.
function toHostTemplate(repl: string): string {
  if (repl.indexOf("$") < 0) return repl;
  let out = "";
  const n = repl.length;
  let i = 0;
  while (i < n) {
    const c = repl.charCodeAt(i);
    if (c != 36) { out += repl.charAt(i); i++; continue; }
    if (i + 1 >= n) { out += "$$"; i++; continue; }
    const d = repl.charCodeAt(i + 1);
    if (d == 36) { out += "$$"; i += 2; continue; }
    if (d == 38) { out += "${0}"; i += 2; continue; }
    if (d >= 48 && d <= 57) {
      let j = i + 1;
      while (j < n && repl.charCodeAt(j) >= 48 && repl.charCodeAt(j) <= 57) j++;
      out += "${" + repl.substring(i + 1, j) + "}";
      i = j;
      continue;
    }
    if (d == 60) {
      const close = repl.indexOf(">", i + 2);
      if (close > i + 2) {
        out += "${" + repl.substring(i + 2, close) + "}";
        i = close + 1;
        continue;
      }
    }
    out += "$$";
    i++;
  }
  return out;
}

function fetchGroupNames(pattern: ArrayBuffer, source: string): Array<string | null> {
  const packed = _group_names(<i32>changetype<usize>(pattern), pattern.byteLength);
  if (packed < 0) throw hostError("constructor", source, packed);
  // @ts-ignore — i32() truncation and >>> on i64 are valid in AS
  const ptr = i32(packed >>> 32);
  // @ts-ignore
  const len = i32(packed & 0xffffffff);
  const reader = new MsgpackReader(<usize>ptr, <usize>len);
  const count = reader.readArraySize();
  const names = new Array<string | null>(count);
  for (let k = 0; k < count; k++) names[k] = reader.readStrOrNil();
  return names;
}

/**
 * The result of a successful match. Mirrors the array returned by
 * `RegExp.prototype.exec`: index `0` is the whole match, `1..n` the capture
 * groups, with `null` for groups that did not participate.
 */
export class RegExpMatch {
  /** The subject string that was searched. */
  readonly input: string;
  /** UTF-16 index of the start of the whole match in `input`. */
  readonly index: i32;

  private readonly strings: Array<string | null>;
  private readonly byteStarts: i32[];
  private readonly byteEnds: i32[];
  private readonly names: Array<string | null>;
  private readonly buf: ArrayBuffer;
  private groupMap: Map<string, string | null> | null = null;

  constructor(
    input: string,
    buf: ArrayBuffer,
    byteStarts: i32[],
    byteEnds: i32[],
    names: Array<string | null>,
    cursorByte: i32,
    cursorIdx: i32,
  ) {
    this.input = input;
    this.buf = buf;
    this.byteStarts = byteStarts;
    this.byteEnds = byteEnds;
    this.names = names;
    this.index = utf16IndexAt(buf, byteStarts[0], cursorByte, cursorIdx);
    const strings = new Array<string | null>(byteStarts.length);
    for (let i = 0; i < byteStarts.length; i++) {
      const s = byteStarts[i];
      strings[i] = s < 0 ? null : decodeSlice(buf, s, byteEnds[i]);
    }
    this.strings = strings;
  }

  /** Number of entries: capture groups plus one for the whole match. */
  get length(): i32 { return this.strings.length; }

  /** `match[i]` — the whole match for `0`, group `i` otherwise. */
  // @ts-ignore — @operator is an AS-only decorator
  @operator("[]")
  get(i: i32): string | null {
    if (i < 0 || i >= this.strings.length) return null;
    return this.strings[i];
  }

  /** Named group by name, like `match.groups.name`. */
  group(name: string): string | null {
    const idx = this.names.indexOf(name);
    return idx < 0 ? null : this.strings[idx];
  }

  /** All named groups as a Map, like `match.groups`. Empty when the pattern has none. */
  get groups(): Map<string, string | null> {
    let m = this.groupMap;
    if (m === null) {
      m = new Map<string, string | null>();
      for (let i = 1; i < this.names.length; i++) {
        const n = this.names[i];
        if (n !== null) m.set(n, this.strings[i]);
      }
      this.groupMap = m;
    }
    return m;
  }

  /** UTF-16 start index of group `i` in `input`, or `-1` if it did not participate. */
  start(i: i32): i32 {
    if (i < 0 || i >= this.byteStarts.length || this.byteStarts[i] < 0) return -1;
    return utf16IndexAt(this.buf, this.byteStarts[i], this.byteStarts[0], this.index);
  }

  /** UTF-16 end index of group `i` in `input`, or `-1` if it did not participate. */
  end(i: i32): i32 {
    if (i < 0 || i >= this.byteEnds.length || this.byteEnds[i] < 0) return -1;
    return utf16IndexAt(this.buf, this.byteEnds[i], this.byteStarts[0], this.index);
  }

  /** The whole match, like `match[0]`. */
  toString(): string { return this.strings[0]!; }

  // Byte-level accessors for the loops in RegExp.
  // @ts-ignore — @inline is an AS-only decorator
  @inline get startByte(): i32 { return this.byteStarts[0]; }
  // @ts-ignore
  @inline get endByte(): i32 { return this.byteEnds[0]; }
}

/**
 * A regular expression, API-compatible with JavaScript's `RegExp` wherever
 * AssemblyScript allows. The pattern is validated by the host when the
 * `RegExp` is constructed, so build patterns at module scope to fail fast.
 *
 * Supported flags: `g`, `i`, `m`, `s`. `u` and `d` are accepted as no-ops —
 * matching is always Unicode-aware and indices are always available via
 * {@link RegExpMatch.start} / {@link RegExpMatch.end}. `y` and `v` throw.
 *
 * Unsupported syntax: lookahead and lookbehind, backreferences, atomic
 * groups, possessive quantifiers.
 */
export class RegExp {
  /** The pattern text as given to the constructor. */
  readonly source: string;
  /** The flags as given to the constructor. */
  readonly flags: string;
  readonly global: bool;
  readonly ignoreCase: bool;
  readonly multiline: bool;
  readonly dotAll: bool;
  /**
   * Position (UTF-16) where the next `exec` / `test` starts when the `g`
   * flag is set. Updated after every such call, exactly like JavaScript.
   */
  lastIndex: i32 = 0;

  private readonly pattern: ArrayBuffer;
  private readonly names: Array<string | null>;

  constructor(source: string, flags: string = "") {
    this.source = source;
    this.flags = flags;
    let g = false, i = false, m = false, s = false;
    for (let k = 0; k < flags.length; k++) {
      const c = flags.charCodeAt(k);
      if (c == 103) g = true;        // g
      else if (c == 105) i = true;   // i
      else if (c == 109) m = true;   // m
      else if (c == 115) s = true;   // s
      else if (c == 117 || c == 100) {} // u, d: always on
      else throw new SyntaxError("Invalid flags supplied to RegExp constructor '" + flags + "'");
    }
    this.global = g;
    this.ignoreCase = i;
    this.multiline = m;
    this.dotAll = s;

    let inline = "";
    if (i) inline += "i";
    if (m) inline += "m";
    if (s) inline += "s";
    const pattern = String.UTF8.encode(inline.length > 0 ? "(?" + inline + ")" + source : source);
    this.pattern = pattern;
    this.names = fetchGroupNames(pattern, source);
  }

  /** Number of capture groups in the pattern (not counting the whole match). */
  get groupCount(): i32 { return this.names.length - 1; }

  /** Names of the capture groups, indexed by group number; `null` for unnamed groups and index 0. */
  get groupNames(): Array<string | null> { return this.names; }

  private capturesAt(
    input: string,
    buf: ArrayBuffer,
    startByte: i32,
    cursorByte: i32,
    cursorIdx: i32,
  ): RegExpMatch | null {
    const packed = _captures(
      <i32>changetype<usize>(this.pattern), this.pattern.byteLength,
      <i32>changetype<usize>(buf), buf.byteLength,
      startByte,
    );
    if (packed == RC_NO_MATCH) return null;
    if (packed < 0) throw hostError("exec", this.source, packed);
    // @ts-ignore
    const ptr = <usize>i32(packed >>> 32);
    // @ts-ignore
    const len = i32(packed & 0xffffffff);
    const groups = len >> 3;
    const starts = new Array<i32>(groups);
    const ends = new Array<i32>(groups);
    for (let k = 0; k < groups; k++) {
      // @ts-ignore — load<i32> is an AS intrinsic
      starts[k] = load<i32>(ptr + <usize>(k << 3));
      // @ts-ignore
      ends[k] = load<i32>(ptr + <usize>(k << 3) + 4);
    }
    return new RegExpMatch(input, buf, starts, ends, this.names, cursorByte, cursorIdx);
  }

  private nextStart(buf: ArrayBuffer, m: RegExpMatch): i32 {
    const end = m.endByte;
    if (end > m.startByte) return end;
    if (end >= buf.byteLength) return end + 1;
    // @ts-ignore
    return end + utf8CharLen(load<u8>(changetype<usize>(buf) + <usize>end));
  }

  /**
   * Like `RegExp.prototype.exec`: the first match, or `null`. With the `g`
   * flag the search starts at `lastIndex`, which is then moved past the match
   * (or reset to 0 when nothing matches).
   */
  exec(input: string): RegExpMatch | null {
    const buf = String.UTF8.encode(input);
    let startIdx = 0;
    let startByte = 0;
    if (this.global) {
      startIdx = this.lastIndex;
      if (startIdx < 0) startIdx = 0;
      if (startIdx > input.length) { this.lastIndex = 0; return null; }
      startByte = utf8OffsetOf(input, startIdx);
    }
    const m = this.capturesAt(input, buf, startByte, startByte, startIdx);
    if (this.global) {
      this.lastIndex = m === null ? 0 : m.end(0);
    }
    return m;
  }

  /**
   * Like `RegExp.prototype.test`. With the `g` flag this honours and advances
   * `lastIndex` just as JavaScript does; without it, it is a single host call.
   */
  test(input: string): bool {
    if (this.global) return this.exec(input) !== null;
    const buf = String.UTF8.encode(input);
    const rc = _is_match(
      <i32>changetype<usize>(this.pattern), this.pattern.byteLength,
      <i32>changetype<usize>(buf), buf.byteLength,
    );
    if (rc < 0) throw hostError("test", this.source, <i64>rc);
    return rc == 1;
  }

  /**
   * Like `str.search(re)`: UTF-16 index of the first match, or `-1`. Ignores
   * `g` and `lastIndex`.
   */
  search(input: string): i32 {
    const buf = String.UTF8.encode(input);
    const m = this.capturesAt(input, buf, 0, 0, 0);
    return m === null ? -1 : m.index;
  }

  /**
   * Like `str.match(re)`. Without `g`: the first match and its groups as
   * strings (`null` entries for absent groups). With `g`: every whole match.
   * `null` when nothing matches.
   */
  match(input: string): Array<string | null> | null {
    if (!this.global) {
      const buf = String.UTF8.encode(input);
      const m = this.capturesAt(input, buf, 0, 0, 0);
      if (m === null) return null;
      const out = new Array<string | null>(m.length);
      for (let k = 0; k < m.length; k++) out[k] = m.get(k);
      return out;
    }
    this.lastIndex = 0;
    const all = this.matchAll(input);
    if (all.length == 0) return null;
    const out = new Array<string | null>(all.length);
    for (let k = 0; k < all.length; k++) out[k] = all[k].get(0);
    return out;
  }

  /**
   * Like `str.matchAll(re)`, returned as an array rather than an iterator.
   * Always scans the whole string from the start regardless of `g` or
   * `lastIndex`.
   */
  matchAll(input: string): RegExpMatch[] {
    const buf = String.UTF8.encode(input);
    const out = new Array<RegExpMatch>();
    let startByte = 0;
    let cursorByte = 0;
    let cursorIdx = 0;
    while (startByte <= buf.byteLength) {
      const m = this.capturesAt(input, buf, startByte, cursorByte, cursorIdx);
      if (m === null) break;
      out.push(m);
      cursorByte = m.startByte;
      cursorIdx = m.index;
      startByte = this.nextStart(buf, m);
    }
    return out;
  }

  /**
   * Like `str.replace(re, replacement)`: replaces the first match, or every
   * match when the `g` flag is set. The replacement understands `$1`,
   * `$<name>`, `$&` and `$$`. Runs as a single host call.
   */
  replace(input: string, replacement: string): string {
    return this.replaceN(input, replacement, this.global ? 0 : 1);
  }

  /** Like `str.replaceAll(re, replacement)`: every match, regardless of `g`. */
  replaceAll(input: string, replacement: string): string {
    return this.replaceN(input, replacement, 0);
  }

  private replaceN(input: string, replacement: string, limit: i32): string {
    const buf = String.UTF8.encode(input);
    const rep = String.UTF8.encode(toHostTemplate(replacement));
    const packed = _replace(
      <i32>changetype<usize>(this.pattern), this.pattern.byteLength,
      <i32>changetype<usize>(buf), buf.byteLength,
      <i32>changetype<usize>(rep), rep.byteLength,
      limit,
    );
    if (packed < 0) throw hostError("replace", this.source, packed);
    // @ts-ignore
    const ptr = i32(packed >>> 32);
    // @ts-ignore
    const len = i32(packed & 0xffffffff);
    return String.UTF8.decodeUnsafe(<usize>ptr, <usize>len);
  }

  /**
   * Like `str.replace(re, fn)`: the callback receives each match and returns
   * its replacement. Replaces the first match, or every match with `g`.
   */
  replaceWith(input: string, fn: (m: RegExpMatch) => string): string {
    const buf = String.UTF8.encode(input);
    let out = "";
    let last = 0;
    let startByte = 0;
    let cursorByte = 0;
    let cursorIdx = 0;
    while (startByte <= buf.byteLength) {
      const m = this.capturesAt(input, buf, startByte, cursorByte, cursorIdx);
      if (m === null) break;
      out += decodeSlice(buf, last, m.startByte) + fn(m);
      last = m.endByte;
      if (!this.global) break;
      cursorByte = m.startByte;
      cursorIdx = m.index;
      startByte = this.nextStart(buf, m);
    }
    return out + decodeSlice(buf, last, buf.byteLength);
  }

  /**
   * Like `str.split(re, limit)`, including the JavaScript rule that capture
   * groups are spliced into the result. `limit < 0` means no limit.
   */
  split(input: string, limit: i32 = -1): string[] {
    const out = new Array<string>();
    if (limit == 0) return out;
    const buf = String.UTF8.encode(input);
    const size = buf.byteLength;
    if (size == 0) {
      if (this.capturesAt(input, buf, 0, 0, 0) === null) out.push(input);
      return out;
    }
    let p = 0;
    let q = 0;
    let cursorByte = 0;
    let cursorIdx = 0;
    while (q < size) {
      const m = this.capturesAt(input, buf, q, cursorByte, cursorIdx);
      if (m === null) break;
      const ms = m.startByte;
      const me = m.endByte;
      if (ms >= size) break;
      if (me == ms && ms == p) {
        q = this.nextStart(buf, m);
        continue;
      }
      out.push(decodeSlice(buf, p, ms));
      if (limit > 0 && out.length >= limit) return out;
      for (let k = 1; k < m.length; k++) {
        const g = m.get(k);
        out.push(g === null ? "" : g);
        if (limit > 0 && out.length >= limit) return out;
      }
      cursorByte = ms;
      cursorIdx = m.index;
      p = me;
      q = me == ms ? this.nextStart(buf, m) : me;
    }
    out.push(decodeSlice(buf, p, size));
    return out;
  }

  /** `/source/flags`, like JavaScript. */
  toString(): string { return "/" + this.source + "/" + this.flags; }
}
