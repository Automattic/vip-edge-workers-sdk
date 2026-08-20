import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asc = resolve(repoRoot, 'node_modules/.bin/asc');
const exampleNames = [
  'fetch', 'headers', 'html-rewrite', 'json', 'kv',
  'rate-limit', 'redirect', 'rewrite', 'udger', 'webhook',
];

function compileExample(name) {
  const tempRoot = mkdtempSync(join(tmpdir(), `vip-edge-workers-${name}-`));
  const nodeModules = join(tempRoot, 'node_modules');
  const packageScope = join(nodeModules, '@automattic');
  const wasm = join(tempRoot, `${name}.wasm`);

  mkdirSync(packageScope, { recursive: true });
  symlinkSync(repoRoot, join(packageScope, 'vip-edge-workers-sdk'), 'dir');

  const result = spawnSync(asc, [
    resolve(repoRoot, `examples/${name}/assembly/index.ts`),
    '--outFile', wasm,
    '--runtime', 'stub',
    '--path', nodeModules,
  ], {
    cwd: nodeModules,
    encoding: 'utf8',
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return new WebAssembly.Module(readFileSync(wasm));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

test('KV example exports the marker required to read the request body', () => {
  const module = compileExample('kv');
  const exports = WebAssembly.Module.exports(module).map(({ name }) => name);

  assert.ok(
    exports.includes('client_request_body'),
    'PUT /note reads req.text(), so the worker must export client_request_body',
  );
});

test('HTML rewrite example installs the promised link protections', () => {
  const source = readFileSync(
    resolve(repoRoot, 'examples/html-rewrite/assembly/index.ts'),
    'utf8',
  );

  assert.match(
    source,
    /\.setAttr\("a\[href\]", "rel", "noreferrer noopener"\)/,
  );
  compileExample('html-rewrite');
});

test('Udger example rejects both user-agent and IP crawlers', () => {
  const source = readFileSync(
    resolve(repoRoot, 'examples/udger/assembly/index.ts'),
    'utf8',
  );

  assert.match(
    source,
    /agent\.ua_class == "Crawler"\s*\|\|\s*address\.ip_classification == "Crawler"/,
  );
});

test('example lockfiles record the current SDK version', () => {
  const { version } = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));

  for (const name of exampleNames) {
    const lock = JSON.parse(readFileSync(
      resolve(repoRoot, `examples/${name}/package-lock.json`),
      'utf8',
    ));
    assert.equal(lock.packages['../..'].version, version, `${name} lockfile is stale`);
  }
});

test('sync script updates example lockfiles to the root package version', () => {
  const lockfile = resolve(repoRoot, 'examples/fetch/package-lock.json');
  const originals = new Map(exampleNames.map((name) => {
    const path = resolve(repoRoot, `examples/${name}/package-lock.json`);
    return [path, readFileSync(path, 'utf8')];
  }));

  try {
    const lock = JSON.parse(originals.get(lockfile));
    lock.packages['../..'].version = '0.0.0';
    writeFileSync(lockfile, `${JSON.stringify(lock, null, 2)}\n`);

    const result = spawnSync('node', [
      resolve(repoRoot, 'scripts/sync-example-lockfile-versions.mjs'),
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const synced = JSON.parse(readFileSync(lockfile, 'utf8'));
    const { version } = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
    assert.equal(synced.packages['../..'].version, version);
  } finally {
    for (const [path, original] of originals) {
      writeFileSync(path, original);
    }
  }
});
