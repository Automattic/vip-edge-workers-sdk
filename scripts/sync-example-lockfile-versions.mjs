import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const { version } = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const examplesRoot = resolve(repoRoot, 'examples');

for (const entry of readdirSync(examplesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }

  const lockfile = resolve(examplesRoot, entry.name, 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockfile, 'utf8'));
  const packageRecord = lock.packages['../..'];

  if (!packageRecord) {
    throw new Error(`${lockfile} does not contain the SDK package record`);
  }

  packageRecord.version = version;
  writeFileSync(lockfile, `${JSON.stringify(lock, null, 2)}\n`);
}
