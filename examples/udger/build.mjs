import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const nodeModulesDir = resolve(projectRoot, 'node_modules');
const asc = resolve(nodeModulesDir, '.bin/asc');

const { NODE_OPTIONS: _drop, ...env } = process.env;

mkdirSync(resolve(projectRoot, 'build'), { recursive: true });

const shared = [
  resolve(projectRoot, 'assembly/index.ts'),
  '--runtime', 'stub',
  '--transform', 'json-as',
  '--path', nodeModulesDir,
];

execFileSync(asc, [
  ...shared,
  '--outFile', resolve(projectRoot, 'build/debug.wasm'),
  '--textFile', resolve(projectRoot, 'build/debug.wat'),
  '--debug', '--sourceMap',
], { cwd: nodeModulesDir, env, stdio: 'inherit' });

execFileSync(asc, [
  ...shared,
  '--outFile', resolve(projectRoot, 'build/release.wasm'),
  '--textFile', resolve(projectRoot, 'build/release.wat'),
  '--optimizeLevel', '3',
  '--shrinkLevel', '2',
], { cwd: nodeModulesDir, env, stdio: 'inherit' });
