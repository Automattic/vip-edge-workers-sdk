import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asc = resolve(repoRoot, 'node_modules/.bin/asc');

let compiled;

async function compileRegexFixture() {
  if (compiled) return compiled;
  const tempRoot = mkdtempSync(join(tmpdir(), 'vip-edge-workers-regex-'));
  const wasm = join(tempRoot, 'regex.wasm');
  const result = spawnSync(asc, [
    resolve(repoRoot, 'tests/regex.fixture.ts'),
    '--outFile', wasm,
    '--runtime', 'stub',
  ], { cwd: repoRoot, encoding: 'utf8' });
  const bytes = result.status === 0 ? readFileSync(wasm) : null;
  rmSync(tempRoot, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  compiled = new WebAssembly.Module(bytes);
  return compiled;
}

// A JavaScript stand-in for the runtime's `regex` host module. It speaks the
// same ABI (UTF-8 subjects, byte offsets, i32 LE pairs, msgpack group names,
// Rust `${n}` replacement templates) so the SDK wrapper is exercised exactly
// as it will be against the real host. Lookaround and backreferences are
// rejected to mirror the Rust engine.
function mockRegexHost(getExports) {
  const RC_NO_MATCH = -1n;
  const RC_BAD_PATTERN = -2n;
  const calls = [];

  const mem = () => getExports().memory.buffer;
  const utf8 = (ptr, len) => Buffer.from(mem(), ptr, len).toString('utf8');
  const byteOffset = (text, utf16Idx) => Buffer.byteLength(text.slice(0, utf16Idx), 'utf8');
  const utf16Index = (text, byteOff) => Buffer.from(text, 'utf8').subarray(0, byteOff).toString('utf8').length;

  function pack(bytes) {
    const ptr = getExports().alloc(bytes.length);
    new Uint8Array(mem(), ptr, bytes.length).set(bytes);
    return (BigInt(ptr) << 32n) | BigInt(bytes.length);
  }

  function compile(src) {
    if (/\(\?[=!]|\(\?<[=!]|\\[1-9]|\\k</.test(src)) return null;
    let flags = 'dg';
    const inline = src.match(/^\(\?([ims]+)\)/);
    if (inline) { flags += inline[1]; src = src.slice(inline[0].length); }
    src = src.replace(/\(\?P</g, '(?<');
    try { return new RegExp(src, flags); } catch { return null; }
  }

  function groupNames(src) {
    const names = [null];
    let inClass = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') { i++; continue; }
      if (inClass) { if (c === ']') inClass = false; continue; }
      if (c === '[') { inClass = true; continue; }
      if (c !== '(') continue;
      if (src[i + 1] !== '?') { names.push(null); continue; }
      const named = src.slice(i + 2).match(/^P?<([A-Za-z_][A-Za-z0-9_]*)>/);
      if (named) names.push(named[1]);
    }
    return names;
  }

  function msgpackStrOrNil(items) {
    const out = [items.length < 16 ? 0x90 | items.length : null];
    if (out[0] === null) out.splice(0, 1, 0xdc, items.length >> 8, items.length & 0xff);
    for (const s of items) {
      if (s === null) { out.push(0xc0); continue; }
      const b = Buffer.from(s, 'utf8');
      out.push(0xa0 | b.length, ...b);
    }
    return Uint8Array.from(out);
  }

  function expand(template, m, names) {
    let out = '';
    for (let i = 0; i < template.length; i++) {
      if (template[i] !== '$') { out += template[i]; continue; }
      if (template[i + 1] === '$') { out += '$'; i++; continue; }
      let name = null;
      if (template[i + 1] === '{') {
        const close = template.indexOf('}', i + 2);
        if (close > 0) { name = template.slice(i + 2, close); i = close; }
      } else {
        const ident = template.slice(i + 1).match(/^[A-Za-z0-9_]+/);
        if (ident) { name = ident[0]; i += ident[0].length; }
      }
      if (name === null) { out += '$'; continue; }
      const idx = /^\d+$/.test(name) ? Number(name) : names.indexOf(name);
      out += idx >= 0 && m[idx] !== undefined ? m[idx] : '';
    }
    return out;
  }

  const host = {
    is_match(patPtr, patLen, subjPtr, subjLen) {
      calls.push('is_match');
      const re = compile(utf8(patPtr, patLen));
      if (!re) return Number(RC_BAD_PATTERN);
      return re.test(utf8(subjPtr, subjLen)) ? 1 : 0;
    },
    captures(patPtr, patLen, subjPtr, subjLen, start) {
      calls.push('captures');
      const src = utf8(patPtr, patLen);
      const re = compile(src);
      if (!re) return RC_BAD_PATTERN;
      const text = utf8(subjPtr, subjLen);
      re.lastIndex = utf16Index(text, start);
      const m = re.exec(text);
      if (!m) return RC_NO_MATCH;
      const pairs = new Int32Array(m.indices.length * 2);
      m.indices.forEach((pair, i) => {
        pairs[i * 2] = pair ? byteOffset(text, pair[0]) : -1;
        pairs[i * 2 + 1] = pair ? byteOffset(text, pair[1]) : -1;
      });
      return pack(new Uint8Array(pairs.buffer));
    },
    group_names(patPtr, patLen) {
      calls.push('group_names');
      const src = utf8(patPtr, patLen);
      if (!compile(src)) return RC_BAD_PATTERN;
      return pack(msgpackStrOrNil(groupNames(src.replace(/^\(\?[ims]+\)/, ''))));
    },
    replace(patPtr, patLen, subjPtr, subjLen, repPtr, repLen, limit) {
      calls.push('replace');
      const src = utf8(patPtr, patLen);
      const re = compile(src);
      if (!re) return RC_BAD_PATTERN;
      const names = groupNames(src.replace(/^\(\?[ims]+\)/, ''));
      const text = utf8(subjPtr, subjLen);
      const template = utf8(repPtr, repLen);
      let n = 0;
      const out = text.replace(re, (...args) => {
        const hasGroups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
        const m = args.slice(0, hasGroups ? -3 : -2);
        if (limit > 0 && n >= limit) return m[0];
        n++;
        return expand(template, m, names);
      });
      return pack(Buffer.from(out, 'utf8'));
    },
  };
  return { host, calls };
}

async function instantiate() {
  const module = await compileRegexFixture();
  let exports;
  const { host, calls } = mockRegexHost(() => exports);
  const imports = {
    env: {
      // AS passes the message only for `throw new Error("literal")`; a thrown
      // value built elsewhere arrives as a null pointer.
      abort: (msgPtr) => {
        if (msgPtr === 0) throw new Error('AssemblyScript aborted');
        const len = new Uint32Array(exports.memory.buffer, msgPtr - 4, 1)[0];
        const msg = Buffer.from(exports.memory.buffer, msgPtr, len).toString('utf16le');
        throw new Error('AssemblyScript aborted: ' + msg);
      },
    },
    regex: host,
  };
  const instance = await WebAssembly.instantiate(module, imports);
  exports = instance.exports;
  const str = (ptr) => {
    const len = new Uint32Array(exports.memory.buffer, ptr - 4, 1)[0];
    return Buffer.from(exports.memory.buffer, ptr, len).toString('utf16le');
  };
  return { exports, str, calls };
}

test('exec returns groups, names, UTF-16 index and per-group indices', async () => {
  const { exports, str } = await instantiate();
  assert.equal(str(exports.execGroups()), '0|/blog/42/hello-world|42|hello-world|hello-world|3|9-20');
  assert.equal(exports.execNoMatch(), 1);
  assert.equal(exports.absentGroupIsNull(), 1);
});

test('byte offsets from the host are converted to UTF-16 indices', async () => {
  const { exports, str } = await instantiate();
  assert.equal(str(exports.unicodeIndices()), '2|é1|3|4|2|3|4');
});

test('g flag drives lastIndex on exec and test like JavaScript', async () => {
  const { exports, str } = await instantiate();
  assert.equal(str(exports.globalExecAdvancesLastIndex()), '1@1,2|22@3,5|null,0');
  assert.equal(str(exports.testGlobalIsStateful()), '110|0');
  assert.equal(exports.testNonGlobal(), 1);
});

test('non-global test is a single is_match host call', async () => {
  const { exports, calls } = await instantiate();
  calls.length = 0;
  exports.testNonGlobal();
  assert.deepEqual(calls.filter((c) => c !== 'group_names'), ['is_match', 'is_match']);
});

test('i, m and s flags are translated to inline host flags', async () => {
  const { exports, str } = await instantiate();
  assert.equal(str(exports.flagsTranslate()), '1|1|0');
});

test('construction fails loudly for bad flags and unsupported or malformed patterns', async () => {
  const { exports } = await instantiate();
  assert.throws(() => exports.invalidFlagThrows(), /Invalid flags supplied/);
  assert.throws(() => exports.badPatternThrows(), /AssemblyScript aborted/);
  assert.throws(() => exports.lookaheadThrows(), /AssemblyScript aborted/);
});

test('match mirrors String.prototype.match with and without g', async () => {
  const { exports, str } = await instantiate();
  assert.equal(str(exports.matchNonGlobal()), '1,1,null');
  assert.equal(str(exports.matchGlobal()), '1,22|null');
});

test('matchAll terminates on empty matches and exposes groups per match', async () => {
  const { exports, str } = await instantiate();
  assert.equal(str(exports.matchAllEmptyMatchesTerminate()), '3|0,1,2');
  assert.equal(str(exports.matchAllWithGroups()), 'a:1@0,b:2@4');
});

test('replace translates JavaScript templates and respects g', async () => {
  const { exports, str } = await instantiate();
  assert.equal(
    str(exports.replaceFirstAndAll()),
    'a[1]b2|a[1]b[2]|a[1]b[2]|11$-22$|x$ a',
  );
});

test('replaceWith calls back per match', async () => {
  const { exports, str } = await instantiate();
  assert.equal(str(exports.replaceWithFn()), 'a<1>b<2>|a<1>b2|ab');
});

test('split follows the JavaScript algorithm including captures and limits', async () => {
  const { exports, str } = await instantiate();
  assert.equal(str(exports.splitCases()), 'a|b|c;a|-|b;a|b|c;a|b;;0;a|b|');
});

test('search, toString and flag properties', async () => {
  const { exports, str } = await instantiate();
  assert.equal(str(exports.searchIndex()), '1|-1');
  assert.equal(str(exports.toStringAndProps()), '/(a)+(?<b>b)/gi|1100|2|null,null,b');
});
