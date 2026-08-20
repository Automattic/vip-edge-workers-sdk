import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asc = resolve(repoRoot, 'node_modules/.bin/asc');

test('MessagePack strings larger than str16 round-trip', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'vip-edge-workers-msgpack-'));
  const wasm = join(tempRoot, 'msgpack.wasm');

  try {
    const result = spawnSync(asc, [
      resolve(repoRoot, 'tests/msgpack.fixture.ts'),
      '--outFile', wasm,
      '--runtime', 'stub',
    ], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const { instance } = await WebAssembly.instantiate(readFileSync(wasm), {
      env: {
        abort() {
          throw new Error('AssemblyScript aborted');
        },
      },
    });

    assert.equal(instance.exports.roundTripsStr32(), 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
