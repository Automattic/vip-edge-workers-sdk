import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = resolve(repoRoot, 'node_modules/.bin/tsc');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function packPackage(tempRoot) {
  const npmEnv = { ...process.env, npm_config_cache: join(tempRoot, 'npm-cache') };
  const packOutput = run('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination', tempRoot,
  ], { cwd: repoRoot, env: npmEnv });

  return { details: JSON.parse(packOutput)[0], npmEnv };
}

test('published types compile in a fresh TypeScript consumer', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'vip-edge-workers-package-'));
  const consumer = join(tempRoot, 'consumer');
  mkdirSync(consumer, { recursive: true });

  try {
    const { details: { filename }, npmEnv } = packPackage(tempRoot);
    const tarball = join(tempRoot, filename);

    writeFileSync(join(consumer, 'package.json'), JSON.stringify({
      name: 'vip-edge-workers-types-consumer',
      private: true,
    }));
    writeFileSync(join(consumer, 'index.ts'), `
      import { fetch, Headers, KV, RateLimit, Request, Response } from '@automattic/vip-edge-workers-sdk';
      export {
        alloc,
        client_request_body,
        on_client_request,
      } from '@automattic/vip-edge-workers-sdk/assembly/index';

      export function useSdk(req: Request, resp: Response): void {
        const headers = new Headers([['x-test', '1']]);
        req.respondText(200, resp.text(), headers);
        fetch('https://example.com', { headers });
        new Response(null, { status: 204, headers });
        KV.incr('count');
        RateLimit.register('test', 1);
      }
    `);
    writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        module: 'Node16',
        moduleResolution: 'Node16',
        noEmit: true,
        strict: true,
        skipLibCheck: false,
      },
      files: ['index.ts'],
    }));

    run('npm', [
      'install',
      tarball,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
    ], { cwd: consumer, env: npmEnv });
    run(tsc, ['-p', join(consumer, 'tsconfig.json')]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('published package includes its example build surface', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'vip-edge-workers-package-'));

  try {
    const { details } = packPackage(tempRoot);
    const paths = new Set(details.files.map(({ path }) => path));
    const examples = [
      'fetch', 'headers', 'html-rewrite', 'json', 'kv',
      'rate-limit', 'redirect', 'rewrite', 'udger', 'webhook',
    ];

    assert.ok(paths.has('Makefile'));
    for (const name of examples) {
      assert.ok(paths.has(`examples/${name}/package.json`), `${name} package.json missing`);
      assert.ok(paths.has(`examples/${name}/build.mjs`), `${name} build.mjs missing`);
      assert.ok(paths.has(`examples/${name}/assembly/index.ts`), `${name} source missing`);
    }
    assert.equal(
      [...paths].some((path) => path.includes('/node_modules/') || path.includes('/build/')),
      false,
      'generated example dependencies or build output leaked into the package',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
