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
  // Templates and document generation also load from inside the archive.
  const templates = require(ASAR + '/src/core/templates');
  assert.strictEqual(templates.list().length, 6, 'all templates packaged');
  const documents = require(ASAR + '/src/core/documents');
  for (const [format, year] of [['pdf', 2026], ['word', 2026], ['word', 2005], ['excel', 2005]]) {
    const d = await documents.generate({ format, title: 'Invoice', table: { columns: ['Item'], rows: [['x']] } }, { name: 'Org', year, now: new Date() });
    assert.ok(d.content.length > 200, `${format} ${year} generated`);
  }
  console.log('PACKAGED OK: worker parsers, sqlite, templates and document generation work from app.asar');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
