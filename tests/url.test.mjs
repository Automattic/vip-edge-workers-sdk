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

async function compileUrlFixture() {
  if (compiled) return compiled;
  const tempRoot = mkdtempSync(join(tmpdir(), 'vip-edge-workers-url-'));
  const wasm = join(tempRoot, 'url.wasm');
  const result = spawnSync(asc, [
    resolve(repoRoot, 'tests/url.fixture.ts'),
    '--outFile', wasm,
    '--runtime', 'stub',
  ], { cwd: repoRoot, encoding: 'utf8' });
  const bytes = readFileSync(wasm);
  rmSync(tempRoot, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  compiled = new WebAssembly.Module(bytes);
  return compiled;
}

async function instantiate(overrides = {}) {
  const module = await compileUrlFixture();
  const imports = {};
  for (const entry of WebAssembly.Module.imports(module)) {
    imports[entry.module] ??= {};
    imports[entry.module][entry.name] = entry.name === 'abort'
      ? () => { throw new Error('AssemblyScript aborted'); }
      : () => 0;
  }
  imports.request = Object.fromEntries(Object.keys(imports.request ?? {}).map((name) => [name, () => -1n]));
  for (const [mod, fns] of Object.entries(overrides)) {
    Object.assign(imports[mod] ??= {}, fns);
  }
  const instance = await WebAssembly.instantiate(module, imports);
  const { memory } = instance.exports;
  const str = (ptr) => {
    if (ptr === 0) return null;
    const len = new Uint32Array(memory.buffer, ptr - 4, 1)[0];
    return Buffer.from(memory.buffer, ptr, len).toString('utf16le');
  };
  const utf8 = (ptr, len) => Buffer.from(memory.buffer, ptr, len).toString('utf8');
  return { exports: instance.exports, str, utf8 };
}

test('URLSearchParams parses, decodes and looks up', async () => {
  const { exports, str } = await instantiate();
  assert.equal(str(exports.parseGet()), ' x y');
  assert.equal(str(exports.parseGetAll()), '1,3');
  assert.equal(exports.parseEmptyValue(), 1);
  assert.equal(exports.parseEmptyName(), 1);
  assert.equal(exports.missingIsNull(), 1);
  assert.equal(str(exports.decodeUnicode()), 'café & ü');
  assert.equal(str(exports.keysValuesEntries()), 'a,b|1,2|b=2');
});

test('URLSearchParams encodes and mutates like WHATWG', async () => {
  const { exports, str } = await instantiate();
  assert.equal(str(exports.encodeUnicode()), 'q=caf%C3%A9+%26+%C3%BC&safe=A-z_0.9*');
  assert.equal(str(exports.malformedEscapes()), '%zz%4%|100%|%7E%2F%3F%23%3D%26');
  assert.equal(str(exports.setReplacesInPlace()), 'a=9&b=2&c=4');
  assert.equal(str(exports.deleteAll()), 'b=2');
  assert.equal(str(exports.sortIsStable()), 'a=0&b=first&b=second&z=1');
});

test('Request exposes path, query and cached queryParams', async () => {
  const { exports, str } = await instantiate();
  assert.equal(str(exports.requestPathAndSearch()), '/p/a|x=1&y=2|2');
  assert.equal(exports.requestWithoutQuery(), 1);
  assert.equal(exports.requestTrailingQuestionMark(), 1);
  assert.equal(str(exports.queryParamsWriteBack()), '/p?b=2&a=1|/p?a=1&b=2|/p');
  assert.equal(exports.queryParamsCached(), 1);
  assert.equal(str(exports.urlAssignmentResetsCache()), 'other');
  assert.equal(str(exports.pathSetterKeepsQuery()), '/new?k=v');
  assert.equal(str(exports.querySetterVariants()), '/p?a=1|/p?b=2|/p|/p');
});

test('read-only request view reads but rejects url mutation', async () => {
  const { exports } = await instantiate();
  assert.equal(exports.readonlyViewReads(), 1);
  assert.throws(() => exports.readonlyViewSearchParamsThrows(), /AssemblyScript aborted/);
  assert.throws(() => exports.readonlyViewPathnameThrows(), /AssemblyScript aborted/);
});

test('Cookies parse the Cookie header and Request caches by header value', async () => {
  const { exports } = await instantiate();
  assert.equal(exports.cookiesParse(), 1);
  assert.equal(exports.requestCookiesCached(), 1);
  assert.equal(exports.requestCookiesEmpty(), 1);
});

test('Response.redirect builds a redirect and rejects non-redirect statuses', async () => {
  const { exports } = await instantiate();
  assert.equal(exports.responseRedirectDefault(), 1);
  assert.equal(exports.responseRedirectPermanent(), 1);
  assert.throws(() => exports.responseRedirectInvalidStatus(), /AssemblyScript aborted/);
});

test('Request.respondRedirect commits status and Location through the host', async () => {
  const headers = [];
  let sent = null;
  const { exports, utf8 } = await instantiate({
    response: {
      header_append: (np, nl, vp, vl) => { headers.push([utf8(np, nl), utf8(vp, vl)]); return 0; },
      respond: (status, bodyPtr, bodyLen) => { sent = { status, bodyLen }; return 0; },
    },
  });
  exports.respondRedirect();
  assert.deepEqual(headers, [['location', '/to']]);
  assert.deepEqual(sent, { status: 301, bodyLen: 0 });
});
