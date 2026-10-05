// Shared helpers for scripts/setup.mjs and scripts/dev.mjs (plain Node, no dependencies).
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BACKEND = path.join(ROOT, 'backend');
export const FRONTEND = path.join(ROOT, 'frontend');
export const VENV = path.join(BACKEND, '.venv');
export const IS_WIN = process.platform === 'win32';

/** Python interpreter inside backend/.venv. */
export const venvPython = () => path.join(VENV, IS_WIN ? 'Scripts/python.exe' : 'bin/python');

export const hasVenv = () => existsSync(venvPython());

/** npm executable name for spawn (npm is a .cmd shim on Windows). */
export const NPM = IS_WIN ? 'npm.cmd' : 'npm';

/** Run a command, streaming output; exit the script if it fails. */
export function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: IS_WIN && cmd.endsWith('.cmd'), ...opts });
  if (r.status !== 0) {
    console.error(`\n✖ Command failed (exit ${r.status ?? r.signal}): ${cmd} ${args.join(' ')}`);
    process.exit(1);
  }
}
