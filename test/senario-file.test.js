'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const APP = require('path').join(__dirname, '..', 'src', 'core');
const { saveSenario, loadSenario } = require(APP + '/senario-file');
const { Store } = require(APP + '/store');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senario-'));
const store = new Store(dir, null);
store.setSettings({
  ...store.settings,
  openai: { ...store.settings.openai, apiKey: 'sk-secret', model: 'gpt-x' },
  mail: { ...store.settings.mail, host: '10.0.0.25', smtpPort: 2525, password: 'smtp-pass' },
  listener: { ...store.settings.listener, extraAllowedIps: ['10.0.0.26'] },
  scenario: { ...store.settings.scenario, pace: 60, guidance: 'It\'s "recall" week; O\'Brien is angry.' },
});
store.setCompany({ name: 'Northwind Stage Lighting', domain: 'northwind.local', description: 'Lighting hire 💡',
  employees: [{ name: 'John', email: 'john@northwind.local', role: 'Director', responsibilities: 'Everything' }] });
store.setCustomers([
  { name: 'Helen Marsh', email: 'helen@riverside.local', organisation: 'Riverside Theatre', role: 'Promoter', relationship: 'Since 2019',
    personality: 'Brisk', writingStyle: 'Short', signature: 'Tom\nRiverside Theatre' },
  { name: 'Mark R', email: 'mark@pikeevents.local', organisation: 'Pike Events', role: 'PM', relationship: '', personality: '', writingStyle: '', signature: '' },
]);
store.data.threads = {
  t1: { id: 't1', subject: 'Lighting hire', customer: 'helen@riverside.local', updatedAt: '2026-10-06T13:15:55.954Z', messages: [
    { messageId: '<a@riverside.local>', direction: 'out', from: 'helen@riverside.local', fromName: 'Helen Marsh', to: ['john@northwind.local'], cc: [], subject: 'Lighting hire', body: 'Need crew\n— Tom', date: '2026-10-06T13:04:19.290Z' },
    { messageId: '<b@srv>', direction: 'in', from: 'john@northwind.local', fromName: 'John', to: ['helen@riverside.local'], cc: ['x@northwind.local'], subject: 'RE: Lighting hire', body: 'Sure', date: '2026-10-06T13:09:45.000Z' },
  ] },
};
store.data.msgIndex = { '<a@riverside.local>': 't1', '<b@srv>': 't1' };
store.data.sentIds = { '<a@riverside.local>': 1 };
store.data.processedIds = { '<b@srv>': 2 };
const now = Date.now();
store.data.pending = [
  { id: 'j1', type: 'reply', customer: 'helen@riverside.local', threadId: 't1', replyToId: '<b@srv>', due: now + 600000, scenarioMs: 3600000 },
  { id: 'j2', type: 'followup', customer: 'helen@riverside.local', threadId: 't1', afterId: '<a@riverside.local>', attempt: 2, due: now + 7200000, scenarioMs: 14400000 },
];

// 1. Save without credentials, load, compare.
const f1 = path.join(dir, 'Northwind.senario');
saveSenario(f1, store.data, { includeSecrets: false, appVersion: '0.1.0' });
assert.ok(!fs.readdirSync(dir).some((f) => f.includes('.tmp-')), 'no temp file left');
const head = fs.readFileSync(f1).subarray(0, 16).toString();
assert.strictEqual(head, 'SQLite format 3\0');
const l1 = loadSenario(f1);
assert.strictEqual(l1.includesCredentials, false);
assert.strictEqual(l1.data.settings.openai.apiKey, '');
assert.strictEqual(l1.data.settings.mail.password, '');
assert.strictEqual(l1.data.settings.mail.host, '10.0.0.25');
assert.deepStrictEqual(l1.data.settings.listener, store.settings.listener);
assert.deepStrictEqual(l1.data.settings.scenario, store.settings.scenario);
assert.deepStrictEqual(l1.data.company, store.company);
assert.deepStrictEqual(l1.data.customers, store.customers);
assert.deepStrictEqual(l1.data.threads, store.data.threads);
assert.deepStrictEqual(l1.data.msgIndex, store.data.msgIndex);
assert.deepStrictEqual(l1.data.sentIds, store.data.sentIds);
assert.deepStrictEqual(l1.data.processedIds, store.data.processedIds);
const [j1, j2] = l1.data.pending.sort((a, b) => a.id.localeCompare(b.id));
assert.deepStrictEqual({ ...j1, due: 0 }, { ...store.data.pending[0], due: 0 });
assert.deepStrictEqual({ ...j2, due: 0 }, { ...store.data.pending[1], due: 0 });
assert.ok(Math.abs(j1.due - (Date.now() + 600000)) < 2000, 'remaining time preserved');
console.log('OK 1: full round trip (settings, company, customers, threads, jobs, seen ids); secrets stripped');

// 2. Loading a file without credentials keeps the current ones.
const store2 = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'senario-')), null);
store2.data.settings.openai.apiKey = 'sk-mine';
store2.data.settings.mail.password = 'mine';
store2.replaceAll(l1.data, { keepCredentials: !l1.includesCredentials });
assert.strictEqual(store2.settings.openai.apiKey, 'sk-mine');
assert.strictEqual(store2.settings.mail.password, 'mine');
assert.strictEqual(store2.company.name, 'Northwind Stage Lighting');
console.log('OK 2: credentials kept when file has none');

// 3. With credentials: included and restored.
const f2 = path.join(dir, 'with-creds.senario');
saveSenario(f2, store.data, { includeSecrets: true });
const l2 = loadSenario(f2);
assert.strictEqual(l2.includesCredentials, true);
assert.strictEqual(l2.data.settings.openai.apiKey, 'sk-secret');
store2.replaceAll(l2.data, { keepCredentials: !l2.includesCredentials });
assert.strictEqual(store2.settings.openai.apiKey, 'sk-secret');
console.log('OK 3: credentials included on request');

// 4. Overwriting an existing file works (Save to same path).
store.data.company.name = 'Northwind Stage Lighting Ltd';
saveSenario(f1, store.data, {});
assert.strictEqual(loadSenario(f1).data.company.name, 'Northwind Stage Lighting Ltd');
console.log('OK 4: save over existing file');

// 5. Readable with plain SQL.
const db = new DatabaseSync(f1, { readOnly: true });
const rows = db.prepare('SELECT t.subject, count(*) n FROM messages m JOIN threads t ON t.id = m.thread_id GROUP BY t.id').all();
db.close();
assert.strictEqual(rows[0].n, 2);
console.log('OK 5: plain SQLite schema is queryable');

// 6. Bad files are rejected with a clear error.
const junk = path.join(dir, 'junk.senario');
fs.writeFileSync(junk, 'hello');
assert.throws(() => loadSenario(junk), /not a valid \.senario file/);
const other = path.join(dir, 'other.senario');
const odb = new DatabaseSync(other); odb.exec('CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES (\'format\', \'x\')'); odb.close();
assert.throws(() => loadSenario(other), /not a senario file/);
console.log('OK 6: invalid files rejected');
console.log('ALL PASSED');
