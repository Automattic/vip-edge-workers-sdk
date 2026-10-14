import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asc = resolve(repoRoot, 'node_modules/.bin/asc');

function readAsString(memory, ptr) {
  if (!ptr) return '';
  const len = new Uint32Array(memory.buffer, ptr - 4, 1)[0];
  return new TextDecoder('utf-16le').decode(new Uint8Array(memory.buffer, ptr, len));
}

// Host stubs default to "success"; a test overrides the ones it exercises.
async function compileCryptoFixture(hostOverrides = {}) {
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
  const host = {
    get_random_values: () => 0,
    hmac_sha256: () => 0,
    sha256: () => 0,
    constant_time_eq: () => 1,
    jwt_verify_hs256: () => -1n,
    ...hostOverrides,
  };
  const imports = {
    env: {
      abort: (msg) => { throw new Error('AssemblyScript aborted: ' + readAsString(memory, msg)); },
    },
    crypto: {
      get_random_values: (ptr, len) => host.get_random_values(memory, ptr, len),
      hmac_sha256: (...a) => host.hmac_sha256(...a),
      sha256: (...a) => host.sha256(...a),
      constant_time_eq: (...a) => host.constant_time_eq(...a),
      jwt_verify_hs256: (...a) => host.jwt_verify_hs256(...a),
    },
  };
  const instance = await WebAssembly.instantiate(module, imports);
  memory = instance.exports.memory;
  return { exports: instance.exports, tempRoot };
}

const LIMIT = -2;

test('getRandomValues hands the host the data pointer and length of the view', async () => {
  const calls = [];
  const { exports, tempRoot } = await compileCryptoFixture({
    get_random_values: (memory, ptr, len) => {
      calls.push(len);
      new Uint8Array(memory.buffer, ptr, len).fill(0xab);
      return 0;
    },
  });

  try {
    assert.equal(exports.fillsOnlyTheView(), 1);
    assert.deepEqual(calls, [4]);
    assert.equal(exports.returnsSameArray(), 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('the host limit code becomes a RangeError on every crypto call', async () => {
  const { exports, tempRoot } = await compileCryptoFixture({
    get_random_values: () => LIMIT,
    hmac_sha256: () => LIMIT,
    sha256: () => LIMIT,
    constant_time_eq: () => LIMIT,
    jwt_verify_hs256: () => BigInt(LIMIT),
  });

  try {
    for (const fn of ['requestsRandom', 'hmacCall', 'sha256Call', 'compareCall', 'jwtCall']) {
      assert.throws(() => exports[fn](), /input exceeds the host's size limit/, fn);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('any other non-zero host code is an error, never a silent result', async () => {
  const { exports, tempRoot } = await compileCryptoFixture({
    get_random_values: () => -1,
    hmac_sha256: () => -1,
    sha256: () => -1,
    constant_time_eq: () => -1,
  });

  try {
    for (const fn of ['requestsRandom', 'hmacCall', 'sha256Call', 'compareCall']) {
      assert.throws(() => exports[fn](), /host refused the request \(code -1\)/, fn);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('success paths are unchanged', async () => {
  const { exports, tempRoot } = await compileCryptoFixture({
    constant_time_eq: () => 0,
  });

  try {
    assert.equal(exports.hmacDigestLength(), 32);
    assert.equal(exports.compareCall(), 0, 'host 0 means not equal');
    assert.equal(exports.jwtCall(), 1, 'host -1 on a JWT is a plain null');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
