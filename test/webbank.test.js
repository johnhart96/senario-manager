'use strict';
// Online banking website: login, sessions, CSRF, payments (review → confirm), validation,
// escaping, transactions search, CSV/PDF statements, logout, lockout and persistence.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Store } = require(ROOT + '/src/core/store');
const { Engine } = require(ROOT + '/src/core/engine');
const { extractAttachments } = require(ROOT + '/src/core/attachments');
const { saveSenario, loadSenario } = require(ROOT + '/src/core/senario-file');

const PORT = 2681;
const BASE = `http://127.0.0.1:${PORT}`;
let cookie = '';
async function req(p, { method = 'GET', form } = {}) {
  const r = await fetch(BASE + p, {
    method, redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
  const isText = /text|html|csv/.test(r.headers.get('content-type') || '');
  return { status: r.status, location: r.headers.get('location'), headers: r.headers, text: isText ? await r.text() : '', buf: isText ? null : Buffer.from(await r.arrayBuffer()) };
}
const csrfOf = (html) => (html.match(/name="csrf" value="([a-f0-9]+)"/) || [])[1];
const tokenOf = (html) => (html.match(/name="token" value="([a-f0-9]+)"/) || [])[1];
const login = (username, password) => req('/login', { method: 'POST', form: { username, password } });

(async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-')), null);
  store.setCompany({ name: 'Company X', domain: 'co.local', description: 'Sells lamps.', operatingYear: 2005, employees: [] });
  const engine = new Engine(store);
  engine.setBankAccount({ openingBalance: '1000.00', bankName: 'Northern Counties Bank' });
  engine.addBankUser({ username: 'priya', name: 'Priya Shah', password: 'lamps2005' });
  assert.throws(() => engine.addBankUser({ username: 'x', password: 'lamps2005' }), /Usernames/);
  assert.throws(() => engine.addBankUser({ username: 'tom', password: '123' }), /at least 6/);
  await engine.setOnlineBanking({ enabled: true, bindAddress: '127.0.0.1', port: PORT });
  assert.ok(engine.bankState().online.webRunning, engine.bankState().online.webError);

  // 1. Logged out: everything leads to the login page.
  let r = await req('/accounts');
  assert.strictEqual(r.status, 303);
  assert.strictEqual(r.location, '/login');
  r = await req('/login');
  assert.match(r.text, /Log in to Online Banking/);
  assert.match(r.text, /Northern Counties Bank/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
  assert.doesNotMatch(r.text, /<script/i, 'no JavaScript');
  console.log('OK 1: logged out → login page, with security headers and no scripts');

  // 2. Wrong password, then the right one.
  r = await login('priya', 'wrong');
  assert.strictEqual(r.status, 401);
  assert.match(r.text, /username or password is incorrect/);
  r = await login('PRIYA', 'lamps2005');
  assert.strictEqual(r.status, 303);
  assert.strictEqual(r.location, '/accounts');
  assert.match(cookie, /^sid=[a-f0-9]{64}$/);
  r = await req('/accounts');
  assert.match(r.text, /£1,000\.00/);
  assert.match(r.text, /Logged in as Priya Shah/);
  console.log('OK 2: wrong password refused; username is case-insensitive; account shows £1,000.00');

  // 3. A payment: review, confirm, receipt; the ledger and Activity log follow.
  const logs = [];
  engine.on('log', (e) => logs.push(e.message));
  r = await req('/pay');
  let csrf = csrfOf(r.text);
  assert.ok(csrf);
  r = await req('/pay', { method: 'POST', form: { payee: 'Acme Supplies', sortCode: '20 00 00', accountNumber: '12345678', reference: 'INV 2231', amount: '£125.50' } });
  assert.strictEqual(r.status, 303, 'no CSRF token: refused');
  assert.strictEqual(r.location, '/login?expired=1');
  r = await req('/pay', { method: 'POST', form: { csrf, payee: 'Acme Supplies', sortCode: '20 00 00', accountNumber: '12345678', reference: 'INV 2231', amount: '£125.50' } });
  assert.match(r.text, /Check your payment/);
  assert.match(r.text, /20-00-00/);
  const token = tokenOf(r.text);
  assert.strictEqual(store.data.bank.transactions.length, 0, 'nothing paid before confirming');
  r = await req('/pay/confirm', { method: 'POST', form: { csrf, token } });
  assert.match(r.text, /Payment sent/);
  assert.match(r.text, /£125\.50 is on its way to Acme Supplies/);
  const t = store.data.bank.transactions[0];
  assert.strictEqual(t.amount, -12550);
  assert.strictEqual(t.description, 'BP ACME SUPPLIES INV 2231', 'pre-2008: bill payment');
  assert.deepStrictEqual([t.payee, t.sortCode, t.accountNumber, t.by], ['Acme Supplies', '20-00-00', '12345678', 'priya']);
  assert.strictEqual(engine.bankState().balance, 100000 - 12550);
  assert.ok(logs.some((l) => /priya paid £125\.50 to Acme Supplies/.test(l)));
  r = await req('/pay/confirm', { method: 'POST', form: { csrf, token } });
  assert.strictEqual(r.status, 303, 'the same confirmation twice pays once');
  assert.strictEqual(store.data.bank.transactions.length, 1);
  console.log('OK 3: payment reviewed then confirmed once; "BP ACME SUPPLIES INV 2231" −£125.50');

  // 4. Validation: sort code, account number, amount, funds, own account; output escaped.
  const bad = async (form, re) => {
    const x = await req('/pay', { method: 'POST', form: { csrf, payee: 'Acme', sortCode: '200000', accountNumber: '12345678', amount: '10', ...form } });
    assert.strictEqual(x.status, 400, JSON.stringify(form));
    assert.match(x.text, re);
    return x;
  };
  await bad({ sortCode: '2000' }, /sort code must be 6 digits/);
  await bad({ accountNumber: '1234' }, /account number must be 8 digits/);
  await bad({ amount: '-5' }, /Enter an amount/);
  await bad({ amount: '1e3' }, /Enter an amount/);
  await bad({ amount: '875.51' }, /Insufficient funds: the most you can pay is £874\.50/);
  await bad({ sortCode: '40-12-76', accountNumber: '31926819' }, /can&#39;t pay this account from itself/);
  const x = await bad({ payee: '<script>alert(1)</script>', amount: '99999' }, /Insufficient/);
  assert.ok(x.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !x.text.includes('<script>alert'), 'escaped');
  engine.setBankAccount({ overdraftLimit: '500' });
  r = await req('/pay', { method: 'POST', form: { csrf, payee: 'Big Spend', sortCode: '200000', accountNumber: '87654321', amount: '1000' } });
  assert.match(r.text, /Check your payment/, 'an arranged overdraft raises what can be paid');
  engine.setBankAccount({ overdraftLimit: '0' });
  r = await req('/pay/confirm', { method: 'POST', form: { csrf, token: tokenOf(r.text) } });
  assert.match(r.text, /Insufficient funds/, 'funds are checked again on confirm');
  console.log('OK 4: validation, overdraft, re-check on confirm, and escaping');

  // 5. Transactions: search and dates.
  const today = engine.bankState().today;
  engine.addTransaction({ date: today, description: '=HYPERLINK("http://x")', amount: 20 });
  engine.addTransaction({ date: '2005-09-01', description: 'BGC OLD PAYMENT', amount: 5 });
  r = await req('/transactions?q=acme');
  assert.match(r.text, /BP ACME SUPPLIES INV 2231/);
  assert.doesNotMatch(r.text, /HYPERLINK/);
  assert.match(r.text, /1 transaction</);
  r = await req(`/transactions?from=${today}&to=${today}`);
  assert.doesNotMatch(r.text, /OLD PAYMENT/);
  r = await req('/direct-debits');
  assert.match(r.text, /You have no Direct Debits/);
  engine.addDirectDebit({ payee: 'British <Telecom>', amount: 84.37, frequency: 'quarterly', startDate: '2006-01-01' });
  r = await req('/direct-debits');
  assert.match(r.text, /British &lt;Telecom&gt;.*£84\.37.*Quarterly.*01 Jan 2006/s);
  console.log('OK 5: transactions searched and filtered by date; Direct Debits listed');

  // 6. Statements: CSV (formula-safe) and PDF.
  r = await req(`/statements/download?from=2005-09-01&to=${today}&format=csv`);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="Transactions 2005-09-01 to .* \(6819\)\.csv"/);
  const lines = r.text.trim().split('\r\n');
  assert.strictEqual(lines[0], 'Date,Description,Paid out,Paid in,Balance');
  assert.strictEqual(lines[1], '2005-09-01,BGC OLD PAYMENT,,5.00,1005.00', 'oldest first, running balance');
  assert.ok(lines.some((l) => l.includes(`"'=HYPERLINK(""http://x"")"`)), 'formula neutralised');
  r = await req(`/statements/download?from=2005-09-01&to=${today}&format=pdf`);
  assert.strictEqual(r.headers.get('content-type'), 'application/pdf');
  assert.strictEqual(r.buf.subarray(0, 4).toString(), '%PDF');
  const pdfText = (await extractAttachments([{ filename: 's.pdf', content: r.buf, size: r.buf.length, contentType: 'application/pdf' }]))[0].text;
  assert.match(pdfText, /BP ACME SUPPLIES INV 2231/);
  r = await req(`/statements/download?from=${today}&to=2005-01-01&format=pdf`);
  assert.strictEqual(r.status, 400);
  console.log('OK 6: CSV and PDF statements download; bad periods refused');

  // 7. Logout ends the session.
  r = await req('/accounts');
  csrf = csrfOf(r.text);
  const oldCookie = cookie;
  r = await req('/logout', { method: 'POST', form: { csrf } });
  assert.strictEqual(r.location, '/login?out=1');
  cookie = oldCookie;
  r = await req('/accounts');
  assert.strictEqual(r.location, '/login', 'old session cookie no longer works');
  console.log('OK 7: logging out ends the session');

  // 8. Persistence: users kept as hashes, payment details kept.
  const f = path.join(os.tmpdir(), `web-${process.pid}.senario`);
  saveSenario(f, store.data, { includeSecrets: false, appVersion: 'test' });
  assert.ok(!fs.readFileSync(f).includes('lamps2005'), 'no plain-text password in the file');
  const back = loadSenario(f).data.bank;
  assert.deepStrictEqual(back.online, store.data.bank.online);
  assert.strictEqual(back.transactions.find((y) => y.payee).sortCode, '20-00-00');
  fs.rmSync(f);
  console.log('OK 8: users (hashed) and payment details survive .senario');

  // 9. Lockout after repeated failures, and a busy port.
  cookie = '';
  for (let i = 0; i < 5; i++) await login('priya', 'nope');
  r = await login('priya', 'lamps2005');
  assert.match(r.text, /Too many failed attempts/);
  const other = new Engine(new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'wb2-')), null));
  await other.setOnlineBanking({ enabled: true, bindAddress: '127.0.0.1', port: PORT });
  assert.match(other.bankState().online.webError, /already in use/);
  await engine.setOnlineBanking({ enabled: false, bindAddress: '127.0.0.1', port: PORT });
  assert.ok(!engine.bankState().online.webRunning);
  await assert.rejects(fetch(BASE + '/login'), 'switched off: nothing listening');
  console.log('OK 9: lockout after 5 failures; port clash reported; switching off stops the site');

  await engine.shutdown();
  await other.shutdown();
  console.log('ALL PASSED');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
