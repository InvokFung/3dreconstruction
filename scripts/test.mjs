#!/usr/bin/env node
// Run the fast test suites: backend API, pipeline unit tests, frontend lint + tests.
import path from 'node:path';
import { BACKEND, FRONTEND, NPM, hasVenv, run, venvPython } from './lib.mjs';

if (!hasVenv()) {
  console.error('✖ backend/.venv not found. Run `npm run setup` first.');
  process.exit(1);
}
run(venvPython(), ['-m', 'pytest', '-q'], { cwd: BACKEND });
run(venvPython(), ['-m', 'pytest', '-q', '-m', 'not slow'], { cwd: path.join(BACKEND, 'recon') });
run(NPM, ['run', 'lint'], { cwd: FRONTEND });
run(NPM, ['test'], { cwd: FRONTEND });
