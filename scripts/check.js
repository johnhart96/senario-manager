'use strict';

// Cross-platform syntax check of every source file (`npm run check`).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(path.join(root, 'src'));
(function walk(dir) {
  for (const e of fs.readdirSync(dir)) if (e.endsWith('.js')) files.push(path.join(dir, e));
})(path.join(root, 'test'));
files.push(...fs.readdirSync(__dirname).filter((f) => f.endsWith('.js')).map((f) => path.join(__dirname, f)));

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    process.stderr.write(e.stderr.toString());
  }
}
console.log(`${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
