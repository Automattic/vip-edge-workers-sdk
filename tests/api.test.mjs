import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asc = resolve(repoRoot, 'node_modules/.bin/asc');

async function compileApiFixture() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'vip-edge-workers-api-'));
  const wasm = join(tempRoot, 'api.wasm');
  const result = spawnSync(asc, [
    resolve(repoRoot, 'tests/api.fixture.ts'),
    '--outFile', wasm,
    '--runtime', 'stub',
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const module = new WebAssembly.Module(readFileSync(wasm));
  const imports = {};
  for (const entry of WebAssembly.Module.imports(module)) {
    imports[entry.module] ??= {};
    imports[entry.module][entry.name] = entry.name === 'abort'
      ? () => { throw new Error('AssemblyScript aborted'); }
      : () => 0;
  }

  const instance = await WebAssembly.instantiate(module, imports);
  const { memory } = instance.exports;
  const str = (ptr) => {
    const len = new Uint32Array(memory.buffer, ptr - 4, 1)[0];
    return Buffer.from(memory.buffer, ptr, len).toString('utf16le');
  };
  return { exports: instance.exports, str, tempRoot };
}

test('Response.addVary / setVary normalise, merge and refuse what nginx would not cache', async () => {
  const { exports, str, tempRoot } = await compileApiFixture();

  try {
    assert.equal(str(exports.varyAddMergesAndDedupes()), 'accept-encoding, x-device-class, x-locale');
    assert.equal(str(exports.varySetReplacesAllLines()), 'x-locale, x-theme|1');
    assert.equal(exports.varySetEmptyRemoves(), 1);
    assert.equal(exports.varyAcceptsExactly128(), 1);
    assert.throws(() => exports.varyRejectsStar(), /AssemblyScript aborted/);
    assert.throws(() => exports.varyRejectsInvalidName(), /AssemblyScript aborted/);
    assert.throws(() => exports.varyRejectsTooLong(), /AssemblyScript aborted/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('standalone Headers enforce host header validation rules', async () => {
  const { exports, tempRoot } = await compileApiFixture();

  try {
    assert.throws(() => exports.setInvalidHeaderName(), /AssemblyScript aborted/);
    assert.throws(() => exports.appendInvalidHeaderValue(), /AssemblyScript aborted/);
    assert.throws(() => exports.setOversizedHeaderName(), /AssemblyScript aborted/);
    assert.throws(() => exports.setOversizedHeaderValue(), /AssemblyScript aborted/);
    assert.equal(exports.acceptsValidLocalHeader(), 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Response.text decodes only the Uint8Array view', async () => {
  const { exports, tempRoot } = await compileApiFixture();

  try {
    assert.equal(exports.decodesOnlyBodyView(), 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
