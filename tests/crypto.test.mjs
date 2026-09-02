import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asc = resolve(repoRoot, 'node_modules/.bin/asc');

async function compileCryptoFixture(getRandomValues) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'vip-edge-workers-crypto-'));
  const wasm = join(tempRoot, 'crypto.wasm');
  const result = spawnSync(asc, [
    resolve(repoRoot, 'tests/crypto.fixture.ts'),
    '--outFile', wasm,
    '--runtime', 'stub',
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const module = new WebAssembly.Module(readFileSync(wasm));
  let memory;
  const imports = {
    env: { abort: () => { throw new Error('AssemblyScript aborted'); } },
    crypto: { get_random_values: (ptr, len) => getRandomValues(memory, ptr, len) },
  };
  const instance = await WebAssembly.instantiate(module, imports);
  memory = instance.exports.memory;
  return { exports: instance.exports, tempRoot };
}

test('getRandomValues hands the host the data pointer and length of the view', async () => {
  const calls = [];
  const { exports, tempRoot } = await compileCryptoFixture((memory, ptr, len) => {
    calls.push(len);
    new Uint8Array(memory.buffer, ptr, len).fill(0xab);
    return 0;
  });

  try {
    assert.equal(exports.fillsOnlyTheView(), 1);
    assert.deepEqual(calls, [4]);
    assert.equal(exports.returnsSameArray(), 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('getRandomValues refuses requests over 64 KiB without calling the host', async () => {
  let hostCalls = 0;
  const { exports, tempRoot } = await compileCryptoFixture(() => { hostCalls++; return 0; });

  try {
    assert.throws(() => exports.requestsOverCap(), /AssemblyScript aborted/);
    assert.equal(hostCalls, 0);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('getRandomValues throws when the host returns a refusal', async () => {
  const { exports, tempRoot } = await compileCryptoFixture(() => -1);

  try {
    assert.throws(() => exports.requestsRefusedByHost(), /AssemblyScript aborted/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
