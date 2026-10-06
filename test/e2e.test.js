'use strict';
// End-to-end test: customer email → fake mail server; employee reply → app's
// SMTP listener → customer reply. OpenAI is stubbed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SMTPServer } = require('smtp-server');

const ROOT = require('path').join(__dirname, '..');
const APP = ROOT + '/src/core';
const { simpleParser } = require(ROOT + '/node_modules/mailparser');
const nodemailer = require(ROOT + '/node_modules/nodemailer');
const ai = require(APP + '/ai');

ai.writeCustomerEmail = async (_o, { customer }) => ({
  to: 'accounts@companyx.local', cc: ['nobody@gmail.com'],
  subject: 'Invoice INV-2231 query', body: `Hi,\nInvoice INV-2231 looks wrong.\n\n${customer.name}`,
});
const followUpCalls = [];
ai.writeFollowUp = async (_o, a) => { followUpCalls.push(a); return { body: `Just chasing this (attempt ${a.attempt}, waited ${a.waited}).`, addCc: a.attempt >= 2 ? ['sam@companyx.local'] : [] }; };
const replyPrompts = [];
ai.writeCustomerReply = async (_o, { customer, incoming, thread }) => (replyPrompts.push(ai.formatThread(thread)), 0) || ({ shouldReply: true, body: `Thanks, re "${incoming.subject}".\n\n${customer.name}` });

// Fake scenario mail server (receives what customers send).
const captured = [];
const mailServer = new SMTPServer({
  authOptional: true, disabledCommands: ['STARTTLS'],
  onData(stream, session, cb) {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => { captured.push({ raw: Buffer.concat(chunks), rcpt: session.envelope.rcptTo.map((r) => r.address), from: session.envelope.mailFrom.address }); cb(); });
  },
});

const { Store } = require(APP + '/store');
const { Engine } = require(APP + '/engine');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Plays the mail server delivering an employee's reply to the app's listener.
async function deliverToApp(raw, envelope, localAddress = '127.0.0.1') {
  const t = nodemailer.createTransport({ host: '127.0.0.1', port: 2527, ignoreTLS: true, localAddress });
  try { return await t.sendMail({ envelope, raw }); } finally { t.close(); }
}

(async () => {
  await new Promise((r) => mailServer.listen(2526, '127.0.0.1', r));
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-')), null);
  store.setSettings({
    ...store.settings,
    openai: { apiKey: 'x', model: 'm' },
    mail: { ...store.settings.mail, host: '127.0.0.1', smtpPort: 2526, smtpSecurity: 'none' },
    listener: { ...store.settings.listener, bindAddress: '127.0.0.1', port: 2527, offerStartTls: false },
    scenario: { ...store.settings.scenario, replyDelayMinSec: 0, replyDelayMaxSec: 0, minIntervalMin: 600, maxIntervalMin: 600, followUpEnabled: false },
  });
  store.setCompany({
    name: 'Company X', domain: 'companyx.local', description: 'Sells refrigeration.',
    employees: [
      { name: 'Ann Accounts', email: 'accounts@companyx.local', role: 'Accounts', responsibilities: 'invoices' },
      { name: 'Sam Sales', email: 'sam@companyx.local', role: 'Sales', responsibilities: 'orders' },
    ],
  });
  store.setCustomers([{ name: 'Carl Customer', email: 'carl@brightfoods.local', organisation: 'Bright Foods', role: 'Buyer' }]);

  const engine = new Engine(store);
  engine.on('log', (l) => console.log(`  [${l.level}] ${l.message}`));
  await engine.openListener();
  await engine.start();

  // 1. Customer email to the company; the out-of-company Cc must be dropped.
  await engine.sendNow();
  assert.strictEqual(captured.length, 1);
  assert.deepStrictEqual(captured[0].rcpt, ['accounts@companyx.local']);
  assert.strictEqual(captured[0].from, 'carl@brightfoods.local');
  const first = await simpleParser(captured[0].raw);
  console.log('OK 1: customer email sent to employee via mail server, external cc dropped');

  // 2. Employee replies; mail server relays it to the app's listener.
  const reply = [
    'From: Ann Accounts <accounts@companyx.local>',
    'To: Carl Customer <carl@brightfoods.local>',
    'Cc: sam@companyx.local',
    'Subject: RE: Invoice INV-2231 query',
    'Message-ID: <emp-1@companyx.local>',
    `In-Reply-To: ${first.messageId}`,
    `References: ${first.messageId}`,
    'Date: ' + new Date().toUTCString(),
    '',
    'Hi Carl, which line looks wrong?',
    '',
    '________________________________',
    'From: Carl Customer',
    'Sent: today',
  ].join('\r\n');
  await deliverToApp(reply, { from: 'accounts@companyx.local', to: ['carl@brightfoods.local'] });
  await wait(1800);
  assert.strictEqual(captured.length, 2, 'customer should have replied');
  const custReply = await simpleParser(captured[1].raw);
  assert.strictEqual(custReply.inReplyTo, '<emp-1@companyx.local>');
  assert.strictEqual(custReply.subject, 'Re: Invoice INV-2231 query');
  assert.deepStrictEqual(captured[1].rcpt.sort(), ['accounts@companyx.local', 'sam@companyx.local']);
  const thread = Object.values(store.data.threads)[0];
  assert.strictEqual(Object.keys(store.data.threads).length, 1);
  assert.strictEqual(thread.messages.length, 3);
  assert.strictEqual(thread.messages[1].body, 'Hi Carl, which line looks wrong?');
  console.log('OK 2: employee reply received by listener; customer replied-all in thread');

  // 3. Mail for a non-customer domain is refused at RCPT.
  await assert.rejects(deliverToApp('Subject: x\r\n\r\ny', { from: 'a@companyx.local', to: ['bob@gmail.com'] }), /550|No such user|recipients/i);
  console.log('OK 3: recipient outside customer domains rejected');

  // 4. Connections from anything other than the mail server are refused.
  // Needs a second loopback address (Linux/Windows have all of 127/8; macOS only 127.0.0.1).
  const altLoopback = await new Promise((resolve) => {
    const s = require('net').createServer().listen(0, '127.0.0.5', () => s.close(() => resolve(true)));
    s.on('error', () => resolve(false));
  });
  if (altLoopback) {
    await assert.rejects(deliverToApp('Subject: x\r\n\r\ny', { from: 'a@companyx.local', to: ['carl@brightfoods.local'] }, '127.0.0.5'), /554|Access denied/i);
    console.log('OK 4: connection from non-mail-server IP rejected');
  } else {
    console.log('SKIP 4: no second loopback address on this OS (127.0.0.5)');
  }

  // 5. Out-of-office replies are not answered.
  const before = captured.length;
  await deliverToApp('From: accounts@companyx.local\r\nTo: carl@brightfoods.local\r\nAuto-Submitted: auto-replied\r\nMessage-ID: <ooo@x>\r\nSubject: Out of office\r\n\r\nAway', { from: 'accounts@companyx.local', to: ['carl@brightfoods.local'] });
  await wait(1500);
  assert.strictEqual(captured.length, before);
  console.log('OK 5: auto-reply ignored');

  // 6. Employee starts a brand-new thread to the customer.
  await deliverToApp('From: Sam Sales <sam@companyx.local>\r\nTo: carl@brightfoods.local\r\nMessage-ID: <new-1@companyx.local>\r\nSubject: Spring price list\r\n\r\nHi Carl, attached is our new price list.', { from: 'sam@companyx.local', to: ['carl@brightfoods.local'] });
  await wait(1800);
  assert.strictEqual(captured.length, before + 1);
  assert.strictEqual(Object.keys(store.data.threads).length, 2);
  console.log('OK 6: new employee-initiated thread answered');

  // 7. Direct deliver to a non-company address is refused.
  await assert.rejects(engine.deliver({ customer: store.customers[0], to: ['x@gmail.com'], subject: 's', body: 'b' }), /outside the company/);
  console.log('OK 7: outbound restricted to company domain');

  // 8. Reply without In-Reply-To/References (as Exchange sometimes does) threads by subject.
  const threadsBefore = Object.keys(store.data.threads).length;
  const sent8 = captured.length;
  await deliverToApp('From: Ann Accounts <accounts@companyx.local>\r\nTo: carl@brightfoods.local\r\nMessage-ID: <emp-2@mail.northwind.local>\r\nSubject: RE: Invoice INV-2231 query\r\n\r\nCorrected invoice attached.', { from: 'accounts@companyx.local', to: ['carl@brightfoods.local'] });
  await wait(1800);
  assert.strictEqual(Object.keys(store.data.threads).length, threadsBefore, 'should join existing thread');
  assert.strictEqual(captured.length, sent8 + 1);
  console.log('OK 8: reply without reply headers joined existing thread by subject');

  // 9. Scenario stopped: listener stays up, reply is queued, then sent on start.
  await engine.stop();
  assert.ok(engine.listener, 'listener should stay open while stopped');
  const sent9 = captured.length;
  await deliverToApp('From: Sam Sales <sam@companyx.local>\r\nTo: carl@brightfoods.local\r\nMessage-ID: <new-2@companyx.local>\r\nSubject: Delivery date\r\n\r\nCan we deliver Tuesday?', { from: 'sam@companyx.local', to: ['carl@brightfoods.local'] });
  await wait(1500);
  assert.strictEqual(captured.length, sent9, 'no reply while stopped');
  assert.strictEqual(store.data.pending.length, 1, 'reply queued');
  await engine.start();
  await wait(1800);
  assert.strictEqual(captured.length, sent9 + 1, 'queued reply sent after start');
  console.log('OK 9: listener up while stopped; queued reply sent on start');

  // 10. Follow-ups: unanswered email is chased, escalates, and stops when answered.
  store.settings.scenario.followUpEnabled = true;
  store.settings.scenario.followUpMinHours = 1;   // 1 h business time…
  store.settings.scenario.followUpMaxHours = 1;
  store.settings.scenario.followUpMax = 3;
  engine.setPace(3600);                            // …= 1 s at 3600× (test-only pace)
  const sent10 = captured.length;
  await engine.sendNow();
  const orig = await simpleParser(captured[sent10].raw);
  await wait(1700);
  assert.strictEqual(captured.length, sent10 + 2, 'first follow-up sent');
  const fu1 = await simpleParser(captured[sent10 + 1].raw);
  assert.strictEqual(fu1.inReplyTo, orig.messageId);
  assert.strictEqual(fu1.subject, 'Re: ' + orig.subject);
  assert.match(fu1.text, /attempt 1, waited ~60 min/);
  await wait(2000);
  assert.strictEqual(captured.length, sent10 + 3, 'second follow-up sent');
  const fu2 = await simpleParser(captured[sent10 + 2].raw);
  assert.deepStrictEqual(captured[sent10 + 2].rcpt.sort(), ['accounts@companyx.local', 'sam@companyx.local'], 'escalation cc');
  // Employee finally answers: pending chase must be cancelled.
  store.settings.scenario.followUpEnabled = false; // isolate: customer's answer won't schedule new chases
  await deliverToApp(`From: accounts@companyx.local\r\nTo: carl@brightfoods.local\r\nMessage-ID: <emp-10@x>\r\nIn-Reply-To: ${fu2.messageId}\r\nSubject: RE: ${orig.subject}\r\n\r\nSorry for the delay.`, { from: 'accounts@companyx.local', to: ['carl@brightfoods.local'] });
  await wait(300);
  assert.strictEqual(store.data.pending.filter((j) => j.type === 'followup').length, 0, 'chases cancelled after answer');
  await wait(2500);
  assert.strictEqual(captured.length, sent10 + 4, 'only the customer reply, no further chase');
  const thread10 = Object.values(store.data.threads).find((t) => t.subject === 'Invoice INV-2231 query' && t.messages.some((m) => m.messageId === orig.messageId));
  assert.strictEqual(thread10.messages.length, 5);
  console.log('OK 10: follow-ups chase, escalate with cc, and stop once the company replies');

  // 11. Pace change rescales already-scheduled jobs.
  engine.setPace(1);
  store.settings.scenario.replyDelayMinSec = 3600;
  store.settings.scenario.replyDelayMaxSec = 3600;   // 1 hour at real time
  const sent11 = captured.length;
  await deliverToApp('From: sam@companyx.local\r\nTo: carl@brightfoods.local\r\nMessage-ID: <emp-11@x>\r\nSubject: Pace test\r\n\r\nQuick question.', { from: 'sam@companyx.local', to: ['carl@brightfoods.local'] });
  await wait(300);
  const job = store.data.pending.find((j) => j.type === 'reply');
  assert.ok(job.due - Date.now() > 3500000, 'scheduled ~1h out at real time');
  const st = engine.setPace(1800);                    // 1 h → 2 s
  assert.strictEqual(st.pace, 1800);
  assert.ok(job.due - Date.now() < 2500, 'rescaled to ~2 s');
  await wait(3000);
  assert.strictEqual(captured.length, sent11 + 1, 'rescaled reply fired');
  console.log('OK 11: changing pace live rescales pending replies');

  // 12. Employee replies with a PDF quote + spreadsheet (+ signature logo): customer AI reads them.
  engine.setPace(1);
  store.settings.scenario.replyDelayMinSec = 0;
  store.settings.scenario.replyDelayMaxSec = 0;
  const { all } = require('./fixtures');
  const files = await all();
  const t = nodemailer.createTransport({ host: '127.0.0.1', port: 2527, ignoreTLS: true });
  await t.sendMail({
    from: 'Ann Accounts <accounts@companyx.local>', to: 'carl@brightfoods.local', subject: 'Your quote', messageId: '<emp-12@x>',
    text: 'Hi Carl, quote attached as requested.',
    html: '<p>Hi Carl, quote attached as requested.</p><img src="cid:logo">',
    attachments: [
      { filename: 'Quote Q-4471.pdf', content: files['Quote Q-4471.pdf'] },
      { filename: 'Breakdown.xlsx', content: files['Quote Q-4471.xlsx'] },
      { filename: 'image001.png', content: Buffer.from('89504e470d0a1a0a', 'hex'), cid: 'logo' },
    ],
  });
  t.close();
  const sent12 = captured.length;
  await wait(4000);
  assert.strictEqual(captured.length, sent12 + 1, 'customer replied to the quote email');
  const rec = Object.values(store.data.threads).flatMap((th) => th.messages).find((m) => m.messageId === '<emp-12@x>');
  assert.deepStrictEqual(rec.attachments.map((a) => [a.filename, a.status]), [['Quote Q-4471.pdf', 'ok'], ['Breakdown.xlsx', 'ok']], 'logo skipped, both docs read');
  const prompt = replyPrompts[replyPrompts.length - 1];
  assert.match(prompt, /\[Attachment: Quote Q-4471\.pdf[\s\S]*Fresnel hire 12 18\.5 222[\s\S]*792/, 'PDF text in AI prompt');
  assert.match(prompt, /\[Attachment: Breakdown\.xlsx[\s\S]*Wet hire technician \(day\),2,285,570/, 'spreadsheet rows in AI prompt');
  console.log('OK 12: PDF + Excel attachments extracted and given to the customer AI; signature logo ignored');

  // 13. Attachments survive a .senario save/load.
  const { saveSenario, loadSenario } = require(ROOT + '/src/core/senario-file');
  const f = path.join(os.tmpdir(), `att-${process.pid}.senario`);
  saveSenario(f, store.data, {});
  const back = Object.values(loadSenario(f).data.threads).flatMap((th) => th.messages).find((m) => m.messageId === '<emp-12@x>');
  assert.deepStrictEqual(back.attachments, rec.attachments);
  fs.rmSync(f);
  console.log('OK 13: attachments round-trip through .senario files');

  await engine.shutdown();
  assert.strictEqual(engine.listener, null);
  store.flush();
  mailServer.close();
  console.log('ALL PASSED');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
