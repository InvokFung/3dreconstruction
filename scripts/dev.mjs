#!/usr/bin/env node
// Start the whole app for local development:  npm run dev
//   API     http://localhost:8000   (uvicorn --reload)
//   worker  runs reconstruction jobs
//   web     http://localhost:5173   (Vite; proxies /api to the API)
// and makes sure the demo account exists. Ctrl+C stops everything.
import { spawn, spawnSync } from 'node:child_process';
import { BACKEND, FRONTEND, NPM, IS_WIN, hasVenv, venvPython } from './lib.mjs';

export const DEMO = { email: 'demo@webrecon.dev', password: 'demo1234', name: 'Demo' };
const API = 'http://localhost:8000';

if (!hasVenv()) {
  console.error('✖ backend/.venv not found. Run `npm run setup` first.');
  process.exit(1);
}

const colors = { api: 36, worker: 35, web: 32 };
const children = [];

function start(name, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, PYTHONUNBUFFERED: '1' }, shell: IS_WIN && cmd.endsWith('.cmd') });
  const tag = `\x1b[${colors[name]}m${name.padEnd(6)}\x1b[0m│ `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) out.write(tag + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code, sig) => {
    if (!shuttingDown) {
      console.error(`${tag}exited (${code ?? sig}); stopping the others.`);
      shutdown(1);
    }
  });
  children.push(child);
}

let shuttingDown = false;
function shutdown(code = 0) {
  shuttingDown = true;
  for (const c of children) {
    if (c.exitCode !== null) continue;
    // On Windows, kill the whole tree (npm.cmd -> node vite, python -> pipeline).
    if (IS_WIN) spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const py = venvPython();
start('api', py, ['-m', 'uvicorn', 'app.main:app', '--reload', '--reload-dir', 'app', '--port', '8000'], BACKEND);
start('worker', py, ['-m', 'app.worker'], BACKEND);
start('web', NPM, ['run', 'dev', '--', '--port', '5173', '--strictPort'], FRONTEND);

/** Wait for the API, then create the demo account (409 = it already exists). */
async function ensureDemoUser() {
  for (let i = 0; i < 120 && !shuttingDown; i++) {
    try {
      if ((await fetch(`${API}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    const r = await fetch(`${API}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(DEMO),
    });
    if (!r.ok && r.status !== 409) console.error(`Could not create the demo account (HTTP ${r.status}).`);
  } catch (e) {
    console.error(`Could not reach the API to create the demo account: ${e.message}`);
    return;
  }
  console.log(`
  \x1b[1mWebRecon is running\x1b[0m
    Open      http://localhost:5173
    Sign in   ${DEMO.email} / ${DEMO.password}   (or register your own account)
    API docs  ${API}/docs
  Ctrl+C to stop.
`);
}
ensureDemoUser();
