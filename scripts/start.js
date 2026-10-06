'use strict';

// Cross-platform `npm start`: launches Electron with ELECTRON_RUN_AS_NODE removed
// (VS Code's terminal sets it, which would make Electron behave as plain Node).
// Extra arguments are passed through, e.g. `npm start -- --no-sandbox`.

const { spawn } = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
const child = spawn(electron, args.some((a) => !a.startsWith('-')) ? args : ['.', ...args], {
  stdio: 'inherit',
  env,
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : code));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
