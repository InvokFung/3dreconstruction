#!/usr/bin/env node
// One-time local setup:  npm run setup  [-- --no-pipeline]
//   1. creates backend/.venv with the API + reconstruction pipeline dependencies
//      (`uv sync` when uv is installed — recommended — otherwise venv + pip)
//   2. writes backend/.env (with a fresh SECRET_KEY) if it doesn't exist
//   3. installs the frontend's npm packages
// --no-pipeline skips the heavy pipeline deps (PyTorch, COLMAP, Open3D, ...): the UI and API work,
// but reconstruction jobs will fail until you run setup again without it.
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BACKEND, FRONTEND, IS_WIN, NPM, ROOT, VENV, hasVenv, run, venvPython } from './lib.mjs';

const noPipeline = process.argv.includes('--no-pipeline');

/** Find a Python 3.10-3.12 interpreter (3.11 is what the pipeline is verified on). */
function findPython() {
  const candidates = IS_WIN
    ? [['py', ['-3.11']], ['py', ['-3.12']], ['py', ['-3.10']], ['python', []]]
    : [['python3.11', []], ['python3.12', []], ['python3.10', []], ['python3', []], ['python', []]];
  for (const [cmd, pre] of candidates) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
    const v = r.status === 0 ? r.stdout.trim() : null;
    if (v && ['3.10', '3.11', '3.12'].includes(v)) return { cmd, pre, version: v };
  }
  return null;
}

// 1. Python environment -------------------------------------------------------------------------
const hasUv = spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0;

if (hasUv && !noPipeline) {
  // Reads backend/pyproject.toml + uv.lock, creates backend/.venv, downloads Python if needed.
  run('uv', ['sync'], { cwd: BACKEND });
} else if (hasUv) {
  run('uv', ['venv', '--allow-existing', '--python', '3.11'], { cwd: BACKEND });
  run('uv', ['pip', 'install', '-r', 'requirements-dev.txt'], { cwd: BACKEND });
} else {
  console.log('Tip: install uv (https://docs.astral.sh/uv/) for faster, locked installs. Falling back to venv + pip.');
  if (!hasVenv()) {
    const py = findPython();
    if (!py) {
      console.error('✖ Python 3.10–3.12 not found (3.11 recommended). Install uv or Python 3.11 and re-run.');
      process.exit(1);
    }
    console.log(`Using Python ${py.version} (${py.cmd} ${py.pre.join(' ')})`);
    run(py.cmd, [...py.pre, '-m', 'venv', VENV]);
  }
  const pip = (...args) => run(venvPython(), ['-m', 'pip', ...args]);
  pip('install', '--upgrade', 'pip');
  pip('install', '-r', path.join(BACKEND, 'requirements-dev.txt'));
  if (!noPipeline) {
    let reqs = path.join(BACKEND, 'recon', 'requirements.txt');
    if (process.platform !== 'linux') {
      // "+cpu" PyTorch builds only exist for Linux/Windows; macOS PyPI wheels are already CPU/MPS.
      const tmp = path.join(mkdtempSync(path.join(tmpdir(), 'recon-')), 'requirements.txt');
      writeFileSync(tmp, readFileSync(reqs, 'utf8').replace(/\+cpu\b/g, ''));
      reqs = tmp;
    }
    pip('install', '-r', reqs);
    pip('install', '--no-deps', '-r', path.join(BACKEND, 'recon', 'requirements-nodeps.txt'));
  }
}

// 2. backend/.env -------------------------------------------------------------------------------
const envFile = path.join(BACKEND, '.env');
if (!existsSync(envFile)) {
  copyFileSync(path.join(ROOT, '.env.example'), envFile);
  const secret = randomBytes(48).toString('base64url');
  writeFileSync(envFile, readFileSync(envFile, 'utf8').replace(/^SECRET_KEY=.*$/m, `SECRET_KEY=${secret}`));
  console.log('\nWrote backend/.env with a new SECRET_KEY.');
}

// 3. Frontend -----------------------------------------------------------------------------------
run(NPM, ['install'], { cwd: FRONTEND });

console.log(`
✔ Setup complete${noPipeline ? ' (without the reconstruction pipeline)' : ''}.
  Start everything with:  npm run dev
${process.platform === 'linux' ? '  Linux note: the pipeline needs system libraries:  sudo apt-get install -y libgl1 libegl1 libgomp1\n' : ''}`);
