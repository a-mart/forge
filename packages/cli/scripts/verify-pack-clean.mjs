import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(packageRoot, 'dist');
const packDir = await mkdtemp(path.join(os.tmpdir(), 'forge-cli-pack-clean-'));
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

await rm(distDir, { recursive: true, force: true });

try {
  const result = spawnSync(pnpmBin, ['pack', '--dry-run', '--pack-destination', packDir], {
    cwd: packageRoot,
    encoding: 'utf8',
  });

  const output = stripAnsi(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (result.status !== 0) {
    throw new Error(`pnpm pack --dry-run failed with exit ${result.status}:\n${output}`);
  }

  if (!/(^|\s)dist\/cli\.js(\s|$)/m.test(output)) {
    throw new Error(`Expected clean pack output to include dist/cli.js. Output:\n${output}`);
  }

  console.log('Verified clean pack builds and includes dist/cli.js');
} finally {
  await rm(packDir, { recursive: true, force: true });
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}
