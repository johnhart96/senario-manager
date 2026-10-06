'use strict';

// Runs every test/*.test.js in Electron's Node runtime (the same runtime the app
// uses, which provides node:sqlite). Usage: npm test [-- name-filter]
//
// `npm run test:packaged` instead checks a build made with `npm run pack`.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const electron = require('electron');

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
const filter = process.argv[2] || '';

function run(file, args = []) {
  const started = Date.now();
  const r = spawnSync(electron, [file, ...args], { cwd: __dirname, env, encoding: 'utf8', timeout: 180000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ok = r.status === 0 && /ALL PASSED|PACKAGED OK/.test(out);
  const name = path.basename(file);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(28)} ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (!ok || process.env.VERBOSE) console.log(out.replace(/^/gm, '      '));
  return ok;
}

if (filter === '--packaged') {
  // linux-unpacked/ and win-unpacked/ hold resources/app.asar; macOS builds hold
  // mac*/Senario Manager.app/Contents/Resources/app.asar.
  const dist = path.join(__dirname, '..', 'dist');
  const find = (dir, depth) => {
    if (depth < 0 || !fs.existsSync(dir)) return null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === 'app.asar') return p;
      if (e.isDirectory() && !e.name.endsWith('.asar')) {
        const hit = find(p, depth - 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  const asar = find(dist, 5);
  if (!asar) {
    console.error('No unpacked build found in dist/. Run `npm run pack` first.');
    process.exit(1);
  }
  process.exit(run(path.join(__dirname, 'packaged-check.js'), [asar]) ? 0 : 1);
}

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js') && f.includes(filter)).sort();
const results = files.map((f) => run(path.join(__dirname, f)));
const failed = results.filter((r) => !r).length;
console.log(`\n${files.length - failed}/${files.length} suites passed`);
process.exit(failed ? 1 : 0);
