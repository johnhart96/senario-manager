'use strict';
// Runs inside the packaged binary: loads modules from resources/app.asar.
const assert = require('assert');
const ASAR = process.argv[2];
const { all } = require('./fixtures');
const { extractAttachments } = require(ASAR + '/src/core/attachments');
const { saveSenario, loadSenario } = require(ASAR + '/src/core/senario-file');
(async () => {
  const files = await all();
  const out = await extractAttachments(Object.entries(files).map(([filename, content]) => ({ filename, content, size: content.length })));
  for (const a of out) console.log(a.status.padEnd(6), a.filename, a.error || '');
  assert.ok(out.every((a) => a.status === 'ok'), 'all parsed from inside asar');
  const f = require('path').join(require('os').tmpdir(), `pk-${process.pid}.senario`);
  saveSenario(f, { settings: { openai: {}, mail: {} }, company: { name: 'P', employees: [] }, customers: [], parties: [], threads: {}, pending: [] }, {});
  assert.strictEqual(loadSenario(f).data.company.name, 'P');
  require('fs').rmSync(f);
  console.log('PACKAGED OK: worker parsers + sqlite work from app.asar');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
