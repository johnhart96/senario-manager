'use strict';
// Banking: customers pay invoices they're emailed (straight away or after a delay), remittance
// emails, duplicates, manual transactions, emailed PDF statements and persistence.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { SMTPServer } = require('smtp-server');
const ROOT = path.join(__dirname, '..');
const { simpleParser } = require(ROOT + '/node_modules/mailparser');
const nodemailer = require(ROOT + '/node_modules/nodemailer');
const { Store } = require(ROOT + '/src/core/store');
const { Engine } = require(ROOT + '/src/core/engine');
const { extractAttachments } = require(ROOT + '/src/core/attachments');
const { saveSenario, loadSenario } = require(ROOT + '/src/core/senario-file');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(50); } return false; };

// Fake OpenAI: replies agree to pay whatever invoice reference is in the email.
const prompts = [];
let payInvoices = true;
const openai = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const text = JSON.parse(body).messages.map((m) => m.content).join('\n');
    prompts.push(text);
    let content;
    if (/You have just paid/.test(text)) {
      content = { body: 'Hi Ann,\nPaid today by BACS.\n\nCarl', document: { format: 'pdf', title: 'Remittance Advice', reference: 'INV-100', table: { columns: ['Invoice', 'Amount'], rows: [['INV-100', '£1,234.50']] } } };
    } else {
      const ref = (text.match(/Subject: Invoice (INV-\d+)/g) || []).pop();
      const inv = ref && ref.replace('Subject: Invoice ', '');
      const amount = { 'INV-100': '1,234.50', 'INV-200': 300, 'INV-300': 99.99, 'INV-400': 10 }[inv];
      content = { shouldReply: true, body: 'Thanks, will pay.\n\nCarl', expectsResponse: false, payInvoice: payInvoices && inv ? { reference: inv, amount } : null };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) } }] }));
  });
});
const captured = [];
const sink = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], onData(stream, s, cb) {
  const ch = []; stream.on('data', (c) => ch.push(c)); stream.on('end', () => { captured.push({ raw: Buffer.concat(ch), from: s.envelope.mailFrom.address }); cb(); });
} });
const toApp = async (msg) => { const t = nodemailer.createTransport({ host: '127.0.0.1', port: 2605, ignoreTLS: true }); try { return await t.sendMail(msg); } finally { t.close(); } };
const invoice = (to, ref, n) => toApp({ from: 'Ann Accounts <ann@co.local>', to, subject: `Invoice ${ref}`, messageId: `<${ref}-${n || 1}@co.local>`, text: `Please find invoice ${ref} attached.` });

const PROMPT = { name: 'Carl Prompt', email: 'carl@bright.local', organisation: 'Bright Foods Ltd', role: 'Buyer', paymentHabit: 'prompt' };
const SLOW = { name: 'Sue Slow', email: 'sue@slow.local', organisation: 'Slow & Co', role: 'Owner', paymentHabit: 'delayed' };

(async () => {
  await new Promise((r) => openai.listen(2604, '127.0.0.1', r));
  await new Promise((r) => sink.listen(2603, '127.0.0.1', r));
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')), null);
  store.setSettings({ ...store.settings,
    openai: { apiKey: 'x', model: 'm', baseURL: 'http://127.0.0.1:2604/v1' },
    mail: { ...store.settings.mail, host: '127.0.0.1', smtpPort: 2603, smtpSecurity: 'none' },
    listener: { ...store.settings.listener, bindAddress: '127.0.0.1', port: 2605, offerStartTls: false },
    scenario: { ...store.settings.scenario, oooChance: 0, backgroundEnabled: false, replyDelayMinSec: 0, replyDelayMaxSec: 0, minIntervalMin: 600, maxIntervalMin: 600,
      followUpEnabled: false, payPromptMinMin: 0.001, payPromptMaxMin: 0.002, payDelayMinHours: 4, payDelayMaxHours: 8, remittanceChance: 1 } });
  store.setCompany({ name: 'Company X', domain: 'co.local', description: 'Sells lamps.', operatingYear: 2005,
    employees: [{ name: 'Ann Accounts', email: 'ann@co.local', role: 'Accounts', responsibilities: 'invoices' }] });
  store.setCustomers([PROMPT, SLOW]);
  const engine = new Engine(store);
  engine.setBankAccount({ openingBalance: '1000.00' });
  await engine.openListener();
  await engine.start();

  // 1. A "straight away" payer pays, says so with a remittance advice, and the money arrives.
  await invoice(PROMPT.email, 'INV-100');
  assert.ok(await until(() => store.data.bank.transactions.length === 1), 'payment arrived');
  assert.match(prompts.find((p) => /Invoice INV-100/.test(p)), /"payInvoice"/);
  const t1 = store.data.bank.transactions[0];
  assert.strictEqual(t1.amount, 123450, '"1,234.50" read as £1,234.50');
  assert.strictEqual(t1.description, 'BGC BRIGHT FOODS LTD INV-100', 'pre-2008: bank giro credit');
  assert.strictEqual(t1.date, engine.bankState().today, 'dated the day it arrives, on the scenario calendar');
  assert.ok(await until(() => captured.some((c) => /Paid today/.test(c.raw.toString()))), 'remittance email');
  const remit = await simpleParser(captured.find((c) => /Paid today/.test(c.raw.toString())).raw);
  assert.strictEqual(remit.subject, 'Re: Invoice INV-100');
  assert.ok(remit.attachments.some((a) => /Remittance Advice/.test(a.filename)));
  const t1thread = Object.values(store.data.threads).find((t) => t.subject === 'Invoice INV-100');
  assert.strictEqual(t1thread.status, 'resolved', 'a remittance ends the conversation');
  console.log('OK 1: prompt payer: £1,234.50 in, BGC description, remittance advice in the thread');

  // 2. The same invoice again is not paid twice.
  await invoice(PROMPT.email, 'INV-100', 2);
  await wait(2500);
  assert.strictEqual(store.data.bank.transactions.length, 1);
  assert.ok(!store.data.pending.some((j) => j.type === 'payment'));
  console.log('OK 2: the same invoice is never paid twice');

  // 3. A "delayed" payer is expected for hours; Pay now brings it forward.
  await invoice(SLOW.email, 'INV-200');
  assert.ok(await until(() => engine.bankState().expected.length === 1));
  const exp = engine.bankState().expected[0];
  assert.strictEqual(exp.payer, 'Slow & Co');
  assert.strictEqual(exp.amount, 30000);
  assert.ok(exp.due - Date.now() > 3.9 * 3600000, 'due hours away');
  // Even at a fast pace, and for a job saved by 0.8.0–0.9.0 with a future paidOn.
  store.settings.scenario.pace = 60;
  store.data.pending.find((j) => j.id === exp.id).payment.paidOn = '2005-12-31';
  await engine.runPayment(store.data.pending.find((j) => j.id === exp.id));
  store.settings.scenario.pace = 1;
  assert.strictEqual(store.data.bank.transactions[store.data.bank.transactions.length - 1].date, engine.bankState().today, 'never dated ahead of today');
  assert.strictEqual(engine.bankState().expected.length, 0);
  assert.strictEqual(engine.bankState().balance, 100000 + 123450 + 30000);
  console.log('OK 3: delayed payer waits hours; dated today even at 60x or with an old future paidOn');

  // 4. Cancelling a promised payment.
  await invoice(SLOW.email, 'INV-300');
  assert.ok(await until(() => engine.bankState().expected.length === 1));
  engine.cancelPayment(engine.bankState().expected[0].id);
  assert.strictEqual(engine.bankState().expected.length, 0);
  assert.strictEqual(store.data.bank.transactions.length, 2);
  console.log('OK 4: a cancelled payment never arrives');

  // 5. Manual transactions.
  const today = engine.bankState().today;
  engine.addTransaction({ date: today, description: 'DD BRITISH TELECOM', amount: -50 });
  assert.throws(() => engine.addTransaction({ date: today, description: 'x', amount: 0 }), /Enter an amount/);
  let st = engine.bankState();
  assert.strictEqual(st.balance, 100000 + 123450 + 30000 - 5000);
  assert.strictEqual(st.transactions[0].description, 'DD BRITISH TELECOM', 'newest first');
  engine.removeTransaction(st.transactions[0].id);
  engine.addTransaction({ date: today, description: 'DD BRITISH TELECOM', amount: -50 });
  console.log('OK 5: manual money in and out; balance follows');

  // 6. An emailed PDF statement from the bank.
  const fromBank = () => captured.find((c) => c.from === 'statements@northerncountiesbank.local');
  await engine.sendStatement({ to: ['ann@co.local'], from: `${today.slice(0, 8)}01`, until: today });
  assert.ok(await until(() => fromBank()), 'statement sent from the bank');
  const stmt = await simpleParser(fromBank().raw);
  assert.match(stmt.subject, /Your statement for account ending 6819/);
  const pdf = stmt.attachments.find((a) => a.contentType === 'application/pdf');
  assert.ok(pdf && /^Statement 2005-/.test(pdf.filename), pdf && pdf.filename);
  const text = (await extractAttachments([{ filename: pdf.filename, content: pdf.content, size: pdf.size, contentType: 'application/pdf' }]))[0].text;
  for (const s of ['Northern Counties Bank', 'BALANCE BROUGHT FORWARD', 'BGC BRIGHT FOODS LTD INV-100', 'DD BRITISH TELECOM', '£1,000.00', '£2,484.50', 'Money in £1,534.50']) {
    assert.ok(text.includes(s), `statement shows ${s}:\n${text}`);
  }
  const stThread = Object.values(store.data.threads).find((t) => /Your statement/.test(t.subject));
  assert.ok(stThread.background, 'statements are background mail, not a conversation');
  await assert.rejects(engine.sendStatement({ to: ['nobody@co.local'], from: today, until: today }), /Choose who/);
  console.log('OK 6: PDF statement emailed from the bank (opening £1,000.00, closing £2,484.50)');

  // 7. Banking off: no payment field in the prompt.
  store.settings.scenario.bankingEnabled = false;
  await invoice(SLOW.email, 'INV-400');
  assert.ok(await until(() => prompts.some((p) => /Invoice INV-400/.test(p))));
  await wait(300);
  assert.doesNotMatch(prompts.filter((p) => /Invoice INV-400/.test(p)).pop(), /payInvoice/);
  assert.strictEqual(engine.bankState().expected.length, 0);
  store.settings.scenario.bankingEnabled = true;
  console.log('OK 7: banking off: customers don\'t pay');

  // 8. Persistence: account, transactions, promised payments, payment habits; kept on reset.
  await invoice(SLOW.email, 'INV-300', 2);
  assert.ok(await until(() => engine.bankState().expected.length === 1));
  engine.resetConversations();
  assert.strictEqual(engine.bankState().expected.length, 1, 'clearing conversations keeps promised payments');
  const f = path.join(os.tmpdir(), `bank-${process.pid}.senario`);
  saveSenario(f, store.data, { includeSecrets: false, appVersion: 'test' });
  const back = loadSenario(f).data;
  assert.deepStrictEqual(back.bank.transactions, store.data.bank.transactions);
  assert.strictEqual(back.bank.account.openingBalance, 100000);
  const job = back.pending.find((j) => j.type === 'payment');
  assert.deepStrictEqual(job.payment, store.data.pending.find((j) => j.type === 'payment').payment);
  assert.strictEqual(back.customers.find((c) => c.email === SLOW.email).paymentHabit, 'delayed');
  fs.rmSync(f);
  console.log('OK 8: bank, promised payments and habits survive .senario and clearing conversations');

  // 9. Direct debits: dates, back-dated catch-up, collection when due, cancelling, persistence.
  const bankMod = require(ROOT + '/src/core/bank');
  assert.deepStrictEqual([0, 1, 2, 3].map((n) => bankMod.occurrence('2005-01-31', 'monthly', n)), ['2005-01-31', '2005-02-28', '2005-03-31', '2005-04-30'], 'month ends');
  assert.strictEqual(bankMod.occurrence('2004-02-29', 'yearly', 1), '2005-02-28');
  assert.strictEqual(bankMod.occurrence('2005-12-20', 'fortnightly', 1), '2006-01-03');
  assert.strictEqual(bankMod.occurrence('2005-11-30', 'quarterly', 1), '2006-02-28');
  const today9 = engine.bankState().today;
  const [y9, m9, d9] = today9.split('-').map(Number);
  const threeMonthsAgo = bankMod.isoDate(Date.UTC(y9, m9 - 4, Math.min(d9, 28)));
  const before9 = engine.bankState().balance;
  assert.throws(() => engine.addDirectDebit({ payee: '', amount: 5, frequency: 'monthly', startDate: today9 }), /Enter who/);
  assert.throws(() => engine.addDirectDebit({ payee: 'X', amount: 5, frequency: 'daily', startDate: today9 }), /how often/);
  engine.addDirectDebit({ payee: 'British Telecom', reference: 'BT-99', amount: '84.37', frequency: 'monthly', startDate: threeMonthsAgo });
  const bt = store.data.bank.transactions.filter((t) => t.description === 'DD BRITISH TELECOM' && t.directDebit);
  assert.strictEqual(bt.length, 4, `back-dated: every missed month collected (today ${today9}, start ${threeMonthsAgo}): ${JSON.stringify(bt.map((t) => t.date))}`);
  assert.ok(bt.every((t) => t.amount === -8437 && t.directDebit));
  assert.strictEqual(engine.bankState().balance, before9 - bt.length * 8437);
  engine.addDirectDebit({ payee: 'Unit 4 Landlord', amount: 1250, frequency: 'weekly', startDate: bankMod.occurrence(today9, 'weekly', 1) });
  let dds = engine.bankState().directDebits;
  assert.strictEqual(dds.find((d) => d.payee === 'Unit 4 Landlord').collected, 0, 'future: nothing yet');
  assert.strictEqual(dds.find((d) => d.payee === 'Unit 4 Landlord').nextDate, bankMod.occurrence(today9, 'weekly', 1));
  // Its date arrives (pretend a week has passed on the scenario calendar).
  dds = store.data.bank.directDebits;
  dds.find((d) => d.payee === 'Unit 4 Landlord').startDate = today9;
  engine.collectDirectDebits();
  engine.collectDirectDebits();
  assert.strictEqual(store.data.bank.transactions.filter((t) => t.description === 'DD UNIT 4 LANDLORD').length, 1, 'collected once when due');
  const f9 = path.join(os.tmpdir(), `dd-${process.pid}.senario`);
  saveSenario(f9, store.data, { includeSecrets: false, appVersion: 'test' });
  const back9 = loadSenario(f9).data.bank;
  assert.deepStrictEqual(back9.directDebits, store.data.bank.directDebits);
  assert.ok(back9.transactions.filter((t) => t.directDebit).length === bt.length + 1);
  fs.rmSync(f9);
  engine.removeDirectDebit(store.data.bank.directDebits[0].id);
  assert.strictEqual(engine.bankState().directDebits.length, 1);
  assert.strictEqual(store.data.bank.transactions.filter((t) => t.description === 'DD BRITISH TELECOM' && t.directDebit).length, bt.length, 'cancelling keeps what was taken');
  console.log(`OK 9: direct debits (month ends, ${bt.length} back-dated collections, due-date collection once, cancel, .senario)`);

  await engine.shutdown();
  openai.close();
  sink.close();
  console.log('ALL PASSED');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
