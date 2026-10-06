'use strict';
// External parties: never initiate, reply as suppliers, optional chasing, persistence.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { SMTPServer } = require('smtp-server');
const ROOT = require('path').join(__dirname, '..');
const { simpleParser } = require(ROOT + '/node_modules/mailparser');
const nodemailer = require(ROOT + '/node_modules/nodemailer');
const { Store } = require(ROOT + '/src/core/store');
const { Engine } = require(ROOT + '/src/core/engine');
const { saveSenario, loadSenario } = require(ROOT + '/src/core/senario-file');
const { DatabaseSync } = require('node:sqlite');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const prompts = [];
const openai = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const text = JSON.parse(body).messages.map((m) => m.content).join('\n');
    prompts.push(text);
    const content = /shouldReply/.test(text)
      ? { shouldReply: true, body: 'Hi Ann,\nYour VAT liability for Q3 is £4,212.50, due 7 November.\nCould you send me the September bank statement?\n\nDave', expectsResponse: true }
      : { to: 'ann@companyx.local', cc: [], subject: 'Order 40 lamps', body: 'Please quote.\n\nCarl' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) } }] }));
  });
});
const captured = [];
const sink = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], onData(stream, s, cb) {
  const ch = []; stream.on('data', (c) => ch.push(c)); stream.on('end', () => { captured.push({ raw: Buffer.concat(ch), from: s.envelope.mailFrom.address }); cb(); });
} });
const toApp = async (msg) => { const t = nodemailer.createTransport({ host: '127.0.0.1', port: 2595, ignoreTLS: true }); try { return await t.sendMail(msg); } finally { t.close(); } };

const PARTY = { name: 'Dave Smith', email: 'dave@smithaccountants.local', organisation: 'Smith & Co', role: 'Accountant',
  services: 'Year-end accounts, VAT returns and payroll', personality: 'Methodical', writingStyle: 'Brief', signature: 'Dave Smith ACA' };
const CUSTOMER = { name: 'Carl Customer', email: 'carl@bright.local', organisation: 'Bright', role: 'Buyer' };

(async () => {
  await new Promise((r) => openai.listen(2594, '127.0.0.1', r));
  await new Promise((r) => sink.listen(2593, '127.0.0.1', r));
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-')), null);
  store.setSettings({ ...store.settings,
    openai: { apiKey: 'x', model: 'm', baseURL: 'http://127.0.0.1:2594/v1' },
    mail: { ...store.settings.mail, host: '127.0.0.1', smtpPort: 2593, smtpSecurity: 'none' },
    listener: { ...store.settings.listener, bindAddress: '127.0.0.1', port: 2595, offerStartTls: false },
    scenario: { ...store.settings.scenario, replyDelayMinSec: 0, replyDelayMaxSec: 0, minIntervalMin: 600, maxIntervalMin: 600,
      followUpEnabled: true, followUpMinHours: 1, followUpMaxHours: 1, followUpMax: 1 } });
  store.setCompany({ name: 'Company X', domain: 'companyx.local', description: 'Sells lamps.',
    employees: [{ name: 'Ann', email: 'ann@companyx.local', role: 'Finance', responsibilities: 'accounts' }] });
  store.setParties([PARTY]);
  const engine = new Engine(store);
  await engine.openListener();

  // 1. Parties only: the scenario can run, but nothing is ever initiated.
  await engine.start();
  await engine.generateEvent();
  assert.strictEqual(captured.length, 0, 'parties never initiate');
  console.log('OK 1: with only parties defined, scheduled events send nothing');

  // 2. With customers present, initiators are always customers; parties can't be forced to start one.
  store.setCustomers([CUSTOMER]);
  for (let i = 0; i < 8; i++) await engine.generateEvent();
  assert.ok(captured.every((c) => c.from === CUSTOMER.email), 'every initiated email is from a customer');
  await assert.rejects(engine.sendNow(PARTY.email), /external parties only reply/);
  console.log(`OK 2: ${captured.length} generated emails all from customers; "send now" as a party refused`);

  // 3. Employee emails the accountant → accountant replies with supplier framing.
  const before = captured.length;
  await toApp({ from: 'Ann <ann@companyx.local>', to: PARTY.email, subject: 'Q3 VAT', messageId: '<ann-1@x>', text: 'Hi Dave, what do we owe for Q3 VAT?' });
  await wait(2500);
  assert.strictEqual(captured.length, before + 1, 'party replied');
  assert.strictEqual(captured[before].from, PARTY.email);
  const reply = await simpleParser(captured[before].raw);
  assert.strictEqual(reply.inReplyTo, '<ann-1@x>');
  const p = prompts[prompts.length - 1];
  assert.match(p, /external supplier\/contractor working for a company \(their client\)/);
  assert.match(p, /the company is YOUR CLIENT/);
  assert.match(p, /What you do for them: Year-end accounts, VAT returns and payroll/);
  assert.match(p, /You cannot attach files/);
  console.log('OK 3: accountant replied in thread, prompted as a supplier serving their client');

  // 4. Party chasing is off by default even though the reply expects an answer.
  assert.strictEqual(store.data.pending.filter((j) => j.type === 'followup' && j.customer === PARTY.email).length, 0);
  console.log('OK 4: parties do not chase by default');

  // 5. Enable party chasing: next party reply schedules a chase.
  store.settings.scenario.partyFollowUps = true;
  await toApp({ from: 'ann@companyx.local', to: PARTY.email, subject: 'Payroll', messageId: '<ann-2@x>', text: 'Can you run payroll early?' });
  await wait(2500);
  assert.strictEqual(store.data.pending.filter((j) => j.type === 'followup' && j.customer === PARTY.email).length, 1);
  console.log('OK 5: with the option on, parties chase their own unanswered questions');

  // 6. Customers still use customer framing.
  await toApp({ from: 'ann@companyx.local', to: CUSTOMER.email, subject: 'Your order', messageId: '<ann-3@x>', text: 'Quote attached soon.' });
  await wait(2500);
  assert.match(prompts[prompts.length - 1], /external customer\/contact of a company/);
  assert.doesNotMatch(prompts[prompts.length - 1], /YOUR CLIENT/);
  console.log('OK 6: customers keep customer framing');

  // 7. Unknown domains still rejected.
  await assert.rejects(toApp({ from: 'ann@companyx.local', to: 'x@unknown.local', subject: 'x', text: 'y' }), /550|No such user/);
  console.log('OK 7: listener accepts party domains, rejects others');

  // 8. Persistence, including files from before parties existed.
  const f = path.join(os.tmpdir(), `pt-${process.pid}.senario`);
  saveSenario(f, store.data, {});
  assert.deepStrictEqual(loadSenario(f).data.parties, [PARTY]);
  const db = new DatabaseSync(f); db.exec('DROP TABLE parties'); db.close();
  assert.deepStrictEqual(loadSenario(f).data.parties, []);
  fs.rmSync(f);
  console.log('OK 8: parties saved in .senario; older files load with none');

  await engine.shutdown();
  openai.close(); sink.close();
  console.log('ALL PASSED');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
