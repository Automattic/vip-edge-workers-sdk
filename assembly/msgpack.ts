// MessagePack wire encoding — minimal subset for the edge-workers-sdk wire protocol.
// Only the types required by the SDK schemas are implemented.
//
// Wire protocol uses array encoding (positional fields, no names on the wire):
//   Request  (host→guest, guest→host): [method: str, uri: str]
//   Response (host→guest, guest→host): [status: u16]
//   FetchReq (guest→host):             [method: str, url: str,   headers: [[name, value], …]]
//   FetchRes (host→guest):             [status: u16, headers: [[name, value], …], error_kind: str|nil, error_message: str|nil]

// Returns the UTF-8 byte length of s without allocating.
// ASCII fast path: all HTTP header names and most values are pure ASCII, so this
// usually returns s.length after a single scan with no branches taken.
function utf8ByteLength(s: string): i32 {
  const len = s.length;
  for (let i = 0; i < len; i++) {
    if (s.charCodeAt(i) > 0x7f) return utf8ByteLengthSlow(s, i);
  }
  return len;
}

function utf8ByteLengthSlow(s: string, start: i32): i32 {
  let n = start; // bytes for the already-checked ASCII prefix
  const len = s.length;
  for (let i = start; i < len; i++) {
    const c = s.charCodeAt(i);
    if      (c <=   0x7f) n += 1;
    else if (c <=  0x7ff) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } // surrogate pair → U+10000+
    else                                   n += 3;
  }
  return n;
}

export class MsgpackWriter {
  private buf: ArrayBuffer;
  private pos: i32 = 0;

  constructor() {
    this.buf = new ArrayBuffer(256);
  }

  // Ensures at least `bytes` writable bytes remain after the current position.
  // Grows by doubling so reallocs are O(log n) over the lifetime of the writer.
  private reserve(bytes: i32): void {
    const needed = this.pos + bytes;
    let cap = this.buf.byteLength;
    if (needed <= cap) return;
    while (cap < needed) cap *= 2;
    const next = new ArrayBuffer(cap);
    memory.copy(changetype<usize>(next), changetype<usize>(this.buf), <usize>this.pos);
    this.buf = next;
  }

  private p(): usize {
    return changetype<usize>(this.buf) + <usize>this.pos;
  }

  writeArray(count: i32): void {
    if (count <= 15) {
      this.reserve(1);
      // @ts-ignore — store<u8> is an AS intrinsic
      store<u8>(this.p(), 0x90 | <u8>count);
      this.pos++;
    } else {
      this.reserve(3);
      const p = this.p();
      // @ts-ignore
      store<u8>(p,     0xdc);
      // @ts-ignore
      store<u8>(p + 1, <u8>(count >>> 8));
      // @ts-ignore
      store<u8>(p + 2, <u8>(count & 0xff));
      this.pos += 3;
    }
  }

  writeStr(s: string): void {
    const byteLen = utf8ByteLength(s);
    const prefixLen: i32 = byteLen <= 31 ? 1 : byteLen <= 0xff ? 2 : byteLen <= 0xffff ? 3 : 5;
    this.reserve(prefixLen + byteLen);
    const p = this.p();
    if (byteLen <= 31) {
      // @ts-ignore
      store<u8>(p, 0xa0 | <u8>byteLen);
    } else if (byteLen <= 0xff) {
      // @ts-ignore
      store<u8>(p,     0xd9);
      // @ts-ignore
      store<u8>(p + 1, <u8>byteLen);
    } else if (byteLen <= 0xffff) {
      // @ts-ignore
      store<u8>(p,     0xda);
      // @ts-ignore
      store<u8>(p + 1, <u8>(byteLen >>> 8));
      // @ts-ignore
      store<u8>(p + 2, <u8>(byteLen & 0xff));
    } else {
      // @ts-ignore
      store<u8>(p,     0xdb);
      // @ts-ignore
      store<u8>(p + 1, <u8>(byteLen >>> 24));
      // @ts-ignore
      store<u8>(p + 2, <u8>(byteLen >>> 16));
      // @ts-ignore
      store<u8>(p + 3, <u8>(byteLen >>> 8));
      // @ts-ignore
      store<u8>(p + 4, <u8>(byteLen & 0xff));
    }
    // @ts-ignore — encodeUnsafe writes UTF-8 bytes directly into the buffer; no allocation
    String.UTF8.encodeUnsafe(changetype<usize>(s), s.length, p + <usize>prefixLen);
    this.pos += prefixLen + byteLen;
  }

  writeNil(): void {
    this.reserve(1);
    // @ts-ignore
    store<u8>(this.p(), 0xc0);
    this.pos++;
  }

  writeStrOrNil(s: string | null): void {
    if (s === null) this.writeNil();
    else this.writeStr(s);
  }

  writeUint16(v: u16): void {
    if (v <= 0x7f) {
      this.reserve(1);
      // @ts-ignore
      store<u8>(this.p(), <u8>v);
      this.pos++;
    } else {
      this.reserve(3);
      const p = this.p();
      // @ts-ignore
      store<u8>(p,     0xcd);
      // @ts-ignore
      store<u8>(p + 1, <u8>(v >>> 8));
      // @ts-ignore
      store<u8>(p + 2, <u8>(v & 0xff));
      this.pos += 3;
    }
  }

  writeStrPairArray(headers: string[][]): void {
    this.writeArray(headers.length);
    for (let i = 0; i < headers.length; i++) {
      this.writeArray(2);
      this.writeStr(headers[i][0]);
      this.writeStr(headers[i][1]);
    }
  }

  toArrayBuffer(): ArrayBuffer {
    const ab = new ArrayBuffer(this.pos);
    memory.copy(changetype<usize>(ab), changetype<usize>(this.buf), <usize>this.pos);
    return ab;
  }
}

export class MsgpackReader {
  private pos: usize;

  constructor(base: usize, len: usize) {
    this.pos = base;
  }

  private b(): u8 {
    // @ts-ignore — load<u8> is an AS intrinsic
    const v = load<u8>(this.pos);
    this.pos++;
    return v;
  }

  readArraySize(): i32 {
    const b = this.b();
    if ((b & 0xf0) == 0x90) return b & 0x0f;                    // fixarray
    if (b == 0xdc) return (<i32>this.b() << 8) | <i32>this.b(); // array16
    return 0;
  }

  readStr(): string {
    const b = this.b();
    let len: i32 = 0;
    if ((b & 0xe0) == 0xa0) {
      len = b & 0x1f;
    } else if (b == 0xd9) {
      len = <i32>this.b();
    } else if (b == 0xda) {
      len = (<i32>this.b() << 8) | <i32>this.b();
    } else if (b == 0xdb) {
      len = (<i32>this.b() << 24)
        | (<i32>this.b() << 16)
        | (<i32>this.b() << 8)
        | <i32>this.b();
    }
    const s = String.UTF8.decodeUnsafe(this.pos, <usize>len);
    this.pos += <usize>len;
    return s;
  }

  readUint16(): u16 {
    const b = this.b();
    if (b <= 0x7f) return <u16>b;        // positive fixint
    if (b == 0xcc) return <u16>this.b(); // uint8
    if (b == 0xcd) return (<u16>this.b() << 8) | <u16>this.b(); // uint16
    return 0;
  }

  readStrOrNil(): string | null {
    // @ts-ignore — load<u8> is an AS intrinsic
    if (load<u8>(this.pos) == 0xc0) { this.pos++; return null; }
    return this.readStr();
  }

  readStrPairArray(): string[][] {
    const count = this.readArraySize();
    const result = new Array<string[]>(count);
    for (let i = 0; i < count; i++) {
      this.readArraySize(); // always 2 — each element is [name, value]
      const name = this.readStr();
      const value = this.readStr();
      result[i] = [name, value];
    }
    return result;
  }
}
