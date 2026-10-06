'use strict';
// Operating-year test: real prompt building against a fake OpenAI endpoint,
// real SMTP delivery to a sink, and the listener receiving a reply.
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake OpenAI: records prompts, answers with JSON shaped for whichever call it is.
const prompts = [];
const openai = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body);
    const text = j.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    prompts.push(text);
    const content = /shouldReply/.test(text)
      ? { shouldReply: true, body: 'Thanks, I will fax the signed order over.\n\nCarl', expectsResponse: false }
      : { to: 'accounts@companyx.local', cc: [], subject: 'Order for 40 units', body: 'Hi,\nPlease quote for 40 units.\n\nCarl\nTel 0161 555 0101\nFax 0161 555 0102' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) } }] }));
  });
});

const captured = [];
const sink = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], onData(stream, s, cb) {
  const ch = []; stream.on('data', (c) => ch.push(c)); stream.on('end', () => { captured.push(Buffer.concat(ch)); cb(); });
} });

(async () => {
  await new Promise((r) => openai.listen(2598, '127.0.0.1', r));
  await new Promise((r) => sink.listen(2596, '127.0.0.1', r));
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'yr-')), null);
  store.setSettings({ ...store.settings,
    openai: { apiKey: 'x', model: 'm', baseURL: 'http://127.0.0.1:2598/v1' },
    mail: { ...store.settings.mail, host: '127.0.0.1', smtpPort: 2596, smtpSecurity: 'none' },
    listener: { ...store.settings.listener, bindAddress: '127.0.0.1', port: 2597, offerStartTls: false },
    scenario: { ...store.settings.scenario, replyDelayMinSec: 0, replyDelayMaxSec: 0, followUpEnabled: false, minIntervalMin: 600, maxIntervalMin: 600 } });
  store.setCompany({ name: 'Company X', domain: 'companyx.local', description: 'Sells lamps.', operatingYear: 2005, datedEmails: true,
    employees: [{ name: 'Ann Accounts', email: 'accounts@companyx.local', role: 'Accounts', responsibilities: 'quotes' }] });
  store.setCustomers([{ name: 'Carl Customer', email: 'carl@bright.local', organisation: 'Bright', role: 'Buyer' }]);
  const engine = new Engine(store);
  await engine.openListener();
  await engine.start();

  const realNow = new Date();
  const weekday = realNow.toLocaleDateString('en-GB', { weekday: 'long' });

  // 1. Prompt is set in 2005, with period rules; "now" is a 2005 date on the same weekday.
  await engine.sendNow();
  const p1 = prompts[0];
  assert.match(p1, /operates in the year 2005/);
  assert.match(p1, /Never mention or imply anything that did not exist or happen until after 2005/);
  assert.match(p1, new RegExp(`Current date/time: ${weekday}, \\d+ \\w+ 2005`));
  console.log('OK 1: AI prompt is set in 2005 with period rules; now =', p1.match(/Current date\/time: (.*)/)[1]);

  // 2. Email Date header carries the 2005 date, same weekday and time of day as the real clock.
  const m1 = await simpleParser(captured[0]);
  assert.strictEqual(m1.date.getFullYear(), 2005);
  assert.strictEqual(m1.date.getDay(), realNow.getDay());
  assert.strictEqual(m1.date.getHours(), realNow.getHours());
  console.log('OK 2: Date header =', m1.date.toString().slice(0, 24));

  // 3. Employee's reply (their PC clock also says 2005) → customer reply prompt shows 2005 thread dates,
  //    quoted line uses 2005, and the stored record uses the real receipt time.
  const t = nodemailer.createTransport({ host: '127.0.0.1', port: 2597, ignoreTLS: true });
  await t.sendMail({ from: 'accounts@companyx.local', to: 'carl@bright.local', subject: 'RE: Order for 40 units', messageId: '<y3@x>',
    inReplyTo: m1.messageId, date: new Date('2005-10-04T11:00:00'), text: 'Price is £12.50 each.' });
  t.close();
  await wait(2500);
  const p2 = prompts[prompts.length - 1];
  const threadDates = [...p2.matchAll(/^--- (.*?) \| From/gm)].map((x) => x[1]);
  assert.strictEqual(threadDates.length, 2);
  for (const d of threadDates) assert.match(d, /2005/, 'thread dates shown in 2005');
  const reply = await simpleParser(captured[captured.length - 1]);
  assert.match(reply.text, /On \w+, \d+ \w+ 2005 at [\d:]+, accounts@companyx\.local wrote:/);
  const rec = Object.values(store.data.threads)[0].messages.find((m) => m.messageId === '<y3@x>');
  assert.ok(Math.abs(Date.parse(rec.date) - Date.now()) < 60000, 'stored with real receipt time, not the 2005 header');
  console.log('OK 3: thread dates in prompt =', threadDates.join(' / '));

  // 4. "Date emails in the operating year" off → real date in header, prompts still 2005.
  store.company.datedEmails = false;
  await engine.sendNow();
  const m4 = await simpleParser(captured[captured.length - 1]);
  assert.strictEqual(m4.date.getFullYear(), realNow.getFullYear());
  assert.match(prompts[prompts.length - 1], /operates in the year 2005/);
  console.log('OK 4: dated emails off → header uses real date; content still 2005');

  // 5. No operating year → no period rules, real dates.
  store.company.operatingYear = null;
  store.company.datedEmails = true;
  await engine.sendNow();
  assert.doesNotMatch(prompts[prompts.length - 1], /TIME PERIOD/);
  assert.strictEqual((await simpleParser(captured[captured.length - 1])).date.getFullYear(), realNow.getFullYear());
  assert.strictEqual(engine.status().clockOffsetMs, 0);
  console.log('OK 5: without a year everything is present-day');

  // 6. .senario round trip keeps the year settings.
  store.company.operatingYear = 2005;
  store.company.datedEmails = false;
  const f = path.join(os.tmpdir(), `yr-${process.pid}.senario`);
  saveSenario(f, store.data, {});
  const c = loadSenario(f).data.company;
  assert.strictEqual(c.operatingYear, 2005);
  assert.strictEqual(c.datedEmails, false);
  fs.rmSync(f);
  console.log('OK 6: operating year saved in .senario');

  await engine.shutdown();
  openai.close();
  sink.close();
  console.log('ALL PASSED');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
