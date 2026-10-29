'use strict';

// Online banking for the virtual company's account: a small website, served by the app,
// where trainees log in, view transactions, pay money out and export statements.
// Pages are rendered on the server and use no JavaScript; every form carries a CSRF
// token, sessions live in memory and expire when idle, and failed logins are throttled.
//
// api = {
//   state()                    -> engine.bankState()
//   verify(username, password) -> user | null
//   pay({ payee, sortCode, accountNumber, reference, amount (minor), by }) -> transaction
//   statement(from, to)        -> { filename, content } (PDF)
//   log(level, message)
// }

const http = require('http');
const crypto = require('crypto');
const bank = require('./bank');

const SESSION_IDLE_MS = 15 * 60000;
const MAX_FAILS = 5;
const LOCK_MS = 60000;
const MAX_BODY = 16 * 1024;

const esc = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fmtDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));

const CSS = `
:root { --brand: #0d4a5c; --ink: #1d2327; --muted: #5f6b73; --line: #dfe4e7; --bg: #f3f5f6; --ok: #1b7f4b; --err: #b3261e; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.45 Arial, Helvetica, sans-serif; color: var(--ink); background: var(--bg); }
header { background: var(--brand); color: #fff; }
header .in, main, footer { max-width: 980px; margin: 0 auto; padding: 0 20px; }
header .in { display: flex; align-items: center; gap: 24px; min-height: 64px; flex-wrap: wrap; }
.bankname { font-size: 22px; font-weight: bold; }
nav { display: flex; gap: 4px; flex: 1; flex-wrap: wrap; }
nav a { color: #d6e9ef; text-decoration: none; padding: 8px 12px; border-radius: 4px; }
nav a.on, nav a:hover { background: rgba(255,255,255,.14); color: #fff; }
header form { margin: 0; }
header button { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,.5); }
main { padding-top: 28px; padding-bottom: 40px; }
h1 { font-size: 24px; margin: 0 0 18px; font-weight: normal; }
h2 { font-size: 17px; margin: 0 0 12px; }
.panel { background: #fff; border: 1px solid var(--line); border-radius: 6px; padding: 20px; margin-bottom: 18px; }
.acct { display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: wrap; gap: 12px; }
.acct .name { font-size: 18px; font-weight: bold; }
.muted { color: var(--muted); }
.right { text-align: right; }
.small { font-size: 13px; }
.big { font-size: 30px; font-weight: bold; }
.neg { color: var(--err); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid var(--line); }
th { font-size: 13px; color: var(--muted); font-weight: normal; }
td.n, th.n { text-align: right; white-space: nowrap; }
label { display: block; font-size: 13px; color: var(--muted); margin: 12px 0 4px; }
input, select { font: inherit; padding: 8px 10px; border: 1px solid #b9c3c8; border-radius: 4px; width: 100%; background: #fff; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0 16px; }
.actions { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; align-items: center; }
button, .btn { font: inherit; padding: 9px 18px; border-radius: 4px; border: 1px solid var(--brand); background: var(--brand); color: #fff; cursor: pointer; text-decoration: none; display: inline-block; }
.btn.alt, button.alt { background: #fff; color: var(--brand); }
.msg { padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; }
.msg.err { background: #fbe9e7; color: var(--err); }
.msg.ok { background: #e6f4ec; color: var(--ok); }
dl { display: grid; grid-template-columns: 180px 1fr; gap: 8px 16px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; }
.login { max-width: 400px; margin: 40px auto; }
.pager { display: flex; justify-content: space-between; margin-top: 12px; }
footer { color: var(--muted); font-size: 12px; padding-bottom: 30px; }
`;

class WebBank {
  constructor(api) {
    this.api = api;
    this.sessions = new Map(); // sid -> { user, csrf, seen, pending }
    this.fails = new Map(); // ip -> { count, until }
    this.server = null;
  }

  // ---------- lifecycle ----------

  start({ port, bindAddress }) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((e) => {
          this.api.log('error', `Online banking error: ${e.message}`);
          if (!res.headersSent) this.send(res, 500, this.page(null, 'Error', '<div class="panel">Something went wrong. Please try again.</div>'));
        });
      });
      server.headersTimeout = 10000;
      server.requestTimeout = 15000;
      server.once('error', (e) => {
        if (e.code === 'EACCES') {
          reject(new Error(`No permission to listen on port ${port}. Linux reserves ports below 1024 for root; see the installation notes ("Allow port 25") and use the same setting, or choose a port above 1024.`));
        } else if (e.code === 'EADDRINUSE') {
          reject(new Error(`Port ${port} is already in use by another program (a web server?). Stop it or choose another port.`));
        } else reject(e);
      });
      server.listen(port, bindAddress, () => {
        this.server = server;
        this.sweep = setInterval(() => this.expire(), 60000);
        this.sweep.unref();
        resolve();
      });
    });
  }

  stop() {
    clearInterval(this.sweep);
    this.sessions.clear();
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((r) => { server.close(() => r()); server.closeAllConnections(); });
  }

  expire() {
    const now = Date.now();
    for (const [sid, s] of this.sessions) if (now - s.seen > SESSION_IDLE_MS) this.sessions.delete(sid);
    for (const [ip, f] of this.fails) if (f.until && f.until < now) this.fails.delete(ip);
  }

  // ---------- HTTP plumbing ----------

  send(res, status, body, headers = {}) {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(body);
  }

  redirect(res, to, headers = {}) {
    this.send(res, 303, '', { Location: to, ...headers });
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new Error('Request too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))));
      req.on('error', reject);
    });
  }

  session(req) {
    const sid = (String(req.headers.cookie || '').match(/(?:^|;\s*)sid=([a-f0-9]{64})/) || [])[1];
    const s = sid && this.sessions.get(sid);
    if (!s) return null;
    if (Date.now() - s.seen > SESSION_IDLE_MS) { this.sessions.delete(sid); return null; }
    s.seen = Date.now();
    s.sid = sid;
    return s;
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://bank.local');
    const path = url.pathname;
    if (req.method !== 'GET' && req.method !== 'POST') return this.send(res, 405, 'Method not allowed', { Allow: 'GET, POST' });
    if (path === '/style.css') return this.send(res, 200, CSS, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'max-age=300' });
    if (path === '/favicon.ico') return this.send(res, 404, '');

    const s = this.session(req);
    const ip = req.socket.remoteAddress;
    const body = req.method === 'POST' ? await this.readBody(req) : {};
    // Every form carries the session's token; the login form a pre-login one.
    if (req.method === 'POST' && path !== '/login' && (!s || !body.csrf || body.csrf !== s.csrf)) {
      return this.redirect(res, '/login?expired=1');
    }

    if (path === '/login') return req.method === 'POST' ? this.login(req, res, body, ip) : this.loginPage(res, url);
    if (!s) return this.redirect(res, '/login');
    if (path === '/logout' && req.method === 'POST') {
      this.sessions.delete(s.sid);
      this.api.log('info', `Online banking: ${s.user.username} logged out.`);
      return this.redirect(res, '/login?out=1', { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (path === '/' || path === '/accounts') return this.accounts(res, s);
    if (path === '/transactions') return this.transactions(res, s, url);
    if (path === '/pay') return req.method === 'POST' ? this.payReview(res, s, body) : this.payForm(res, s, {});
    if (path === '/pay/confirm' && req.method === 'POST') return this.payConfirm(res, s, body);
    if (path === '/statements') return this.statementsPage(res, s, url);
    if (path === '/direct-debits') return this.directDebits(res, s);
    if (path === '/statements/download') return this.download(res, s, url);
    return this.send(res, 404, this.page(s, 'Not found', '<div class="panel">That page doesn\'t exist. <a href="/accounts">Back to your accounts</a></div>'));
  }

  // ---------- pages ----------

  page(s, title, content, active = '') {
    const st = this.api.state();
    const name = esc(st.account.bankName);
    const link = (href, label) => `<a href="${href}"${active === href ? ' class="on"' : ''}>${label}</a>`;
    const navHtml = s ? `<nav>${link('/accounts', 'Accounts')}${link('/transactions', 'Transactions')}${link('/pay', 'Pay &amp; transfer')}${link('/direct-debits', 'Direct Debits')}${link('/statements', 'Statements')}</nav>
      <form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(s.csrf)}"><button>Log out</button></form>` : '';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - ${name} Online Banking</title><link rel="stylesheet" href="/style.css"></head>
<body><header><div class="in"><div class="bankname">${name}</div>${navHtml}</div></header>
<main>${content}</main>
<footer>${name} Online Banking${s ? ` · Logged in as ${esc(s.user.name || s.user.username)}` : ''}. Never share your password.</footer></body></html>`;
  }

  money(minor) {
    return esc(bank.money(minor, this.api.state().account.currency));
  }

  loginPage(res, url, error) {
    const msg = error ? `<div class="msg err">${esc(error)}</div>`
      : url && url.searchParams.get('out') ? '<div class="msg ok">You have logged out securely.</div>'
        : url && url.searchParams.get('expired') ? '<div class="msg err">Your session has ended. Please log in again.</div>' : '';
    this.send(res, error ? 401 : 200, this.page(null, 'Log in', `<div class="login panel"><h1>Log in to Online Banking</h1>${msg}
      <form method="post" action="/login" autocomplete="off">
        <label for="u">Username</label><input id="u" name="username" required autofocus>
        <label for="p">Password</label><input id="p" name="password" type="password" required>
        <div class="actions"><button>Log in</button></div>
      </form></div>`));
  }

  async login(req, res, body, ip) {
    const f = this.fails.get(ip);
    if (f && f.until > Date.now()) {
      return this.loginPage(res, null, 'Too many failed attempts. Please wait a minute and try again.');
    }
    const user = await this.api.verify(String(body.username || '').trim(), String(body.password || ''));
    if (!user) {
      const count = ((f && f.count) || 0) + 1;
      this.fails.set(ip, { count, until: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      this.api.log('info', `Online banking: failed login for "${String(body.username || '').slice(0, 40)}" from ${ip}.`);
      return this.loginPage(res, null, count >= MAX_FAILS ? 'Too many failed attempts. Please wait a minute and try again.' : 'The username or password is incorrect.');
    }
    this.fails.delete(ip);
    const sid = crypto.randomBytes(32).toString('hex');
    this.sessions.set(sid, { user: { username: user.username, name: user.name }, csrf: crypto.randomBytes(24).toString('hex'), seen: Date.now() });
    this.api.log('info', `Online banking: ${user.username} logged in from ${ip}.`);
    this.redirect(res, '/accounts', { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/` });
  }

  accounts(res, s) {
    const st = this.api.state();
    const a = st.account;
    const recent = st.transactions.slice(0, 8);
    this.send(res, 200, this.page(s, 'Accounts', `<h1>Your accounts</h1>
      <div class="panel acct"><div><div class="name">Business Current Account</div>
        <div class="muted small">${esc(a.accountName || st.companyName)} · Sort code ${esc(a.sortCode)} · Account ${esc(a.accountNumber)}</div></div>
        <div class="right"><div class="muted small">Balance</div><div class="big ${st.balance < 0 ? 'neg' : ''}">${this.money(st.balance)}</div>
        ${st.available !== st.balance ? `<div class="muted small">Available ${this.money(st.available)}</div>` : ''}</div></div>
      <div class="panel"><h2>Recent transactions</h2>${this.table(recent)}
        <div class="actions"><a class="btn alt" href="/transactions">All transactions</a><a class="btn" href="/pay">Make a payment</a></div></div>`, '/accounts'));
  }

  table(rows) {
    if (!rows.length) return '<p class="muted">No transactions.</p>';
    return `<table><thead><tr><th>Date</th><th>Description</th><th class="n">Paid out</th><th class="n">Paid in</th><th class="n">Balance</th></tr></thead><tbody>${rows.map((t) => `<tr>
      <td>${esc(fmtDay(t.date))}</td><td>${esc(t.description)}</td><td class="n">${t.amount < 0 ? this.money(-t.amount) : ''}</td>
      <td class="n">${t.amount > 0 ? this.money(t.amount) : ''}</td><td class="n">${this.money(t.balance)}</td></tr>`).join('')}</tbody></table>`;
  }

  transactions(res, s, url) {
    const st = this.api.state();
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 60);
    const from = validDate(url.searchParams.get('from')) ? url.searchParams.get('from') : '';
    const to = validDate(url.searchParams.get('to')) ? url.searchParams.get('to') : '';
    const pageNo = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const rows = st.transactions.filter((t) => (!q || `${t.description} ${t.reference || ''}`.toLowerCase().includes(q.toLowerCase()))
      && (!from || t.date >= from) && (!to || t.date <= to));
    const per = 25;
    const pages = Math.max(1, Math.ceil(rows.length / per));
    const qs = (p) => `/transactions?${new URLSearchParams({ q, from, to, page: p })}`;
    this.send(res, 200, this.page(s, 'Transactions', `<h1>Transactions</h1>
      <form class="panel" method="get" action="/transactions"><div class="grid">
        <div><label for="q">Search</label><input id="q" name="q" value="${esc(q)}" placeholder="Name or reference"></div>
        <div><label for="from">From</label><input id="from" name="from" type="date" value="${esc(from)}"></div>
        <div><label for="to">To</label><input id="to" name="to" type="date" value="${esc(to)}"></div></div>
        <div class="actions"><button>Show</button><a class="btn alt" href="/transactions">Clear</a>
        <span class="muted small">${rows.length} transaction${rows.length === 1 ? '' : 's'}</span></div></form>
      <div class="panel">${this.table(rows.slice((pageNo - 1) * per, pageNo * per))}
        ${pages > 1 ? `<div class="pager"><span>${pageNo > 1 ? `<a href="${esc(qs(pageNo - 1))}">← Newer</a>` : ''}</span><span class="muted small">Page ${pageNo} of ${pages}</span>
        <span>${pageNo < pages ? `<a href="${esc(qs(pageNo + 1))}">Older →</a>` : ''}</span></div>` : ''}</div>`, '/transactions'));
  }

  payForm(res, s, v, error) {
    const st = this.api.state();
    const payees = [...new Map(st.transactions.filter((t) => t.payee).map((t) => [`${t.payee}|${t.sortCode}|${t.accountNumber}`, t])).values()].slice(0, 20);
    this.send(res, error ? 400 : 200, this.page(s, 'Make a payment', `<h1>Make a payment</h1>
      ${error ? `<div class="msg err">${esc(error)}</div>` : ''}
      <form class="panel" method="post" action="/pay" autocomplete="off"><input type="hidden" name="csrf" value="${esc(s.csrf)}">
        <p class="muted small">From Business Current Account ${esc(st.account.sortCode)} ${esc(st.account.accountNumber)} · Available ${this.money(st.available)}</p>
        <div class="grid">
          <div><label for="payee">Payee name</label><input id="payee" name="payee" maxlength="40" required value="${esc(v.payee)}" list="payees"></div>
          <div><label for="sortCode">Sort code</label><input id="sortCode" name="sortCode" required placeholder="00-00-00" value="${esc(v.sortCode)}"></div>
          <div><label for="accountNumber">Account number</label><input id="accountNumber" name="accountNumber" required placeholder="8 digits" value="${esc(v.accountNumber)}"></div>
          <div><label for="reference">Reference (shown to the payee)</label><input id="reference" name="reference" maxlength="18" value="${esc(v.reference)}"></div>
          <div><label for="amount">Amount</label><input id="amount" name="amount" required inputmode="decimal" placeholder="0.00" value="${esc(v.amount)}"></div>
        </div>
        <datalist id="payees">${payees.map((t) => `<option value="${esc(t.payee)}">`).join('')}</datalist>
        ${payees.length ? `<p class="muted small">Previous payees: ${payees.map((t) => `${esc(t.payee)} (${esc(t.sortCode)} ${esc(t.accountNumber)})`).join(', ')}</p>` : ''}
        <div class="actions"><button>Continue</button><a class="btn alt" href="/accounts">Cancel</a></div></form>`, '/pay'));
  }

  // Validates a payment; returns [details, error].
  check(body) {
    const st = this.api.state();
    const payee = String(body.payee || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const digits = (x) => String(x || '').replace(/[\s-]/g, '');
    const sc = digits(body.sortCode);
    const acc = digits(body.accountNumber);
    const reference = String(body.reference || '').trim().slice(0, 18);
    const amountText = String(body.amount || '').replace(/[£$€,\s]/g, '');
    const amount = /^\d+(\.\d{1,2})?$/.test(amountText) ? Math.round(Number(amountText) * 100) : NaN;
    const v = { payee, sortCode: body.sortCode, accountNumber: body.accountNumber, reference, amount: body.amount };
    if (!payee) return [v, 'Enter the payee\'s name.'];
    if (!/^\d{6}$/.test(sc)) return [v, 'The sort code must be 6 digits, like 20-00-00.'];
    if (!/^\d{8}$/.test(acc)) return [v, 'The account number must be 8 digits.'];
    if (sc === bank.digits(st.account.sortCode) && acc === bank.digits(st.account.accountNumber)) return [v, 'You can\'t pay this account from itself.'];
    if (!(amount > 0)) return [v, 'Enter an amount, like 125.50.'];
    if (amount > st.available) return [v, `Insufficient funds: the most you can pay is ${bank.money(Math.max(0, st.available), st.account.currency)}.`];
    return [{ payee, sortCode: `${sc.slice(0, 2)}-${sc.slice(2, 4)}-${sc.slice(4)}`, accountNumber: acc, reference, amount }, null];
  }

  payReview(res, s, body) {
    const [p, error] = this.check(body);
    if (error) return this.payForm(res, s, p, error);
    s.pending = { ...p, token: crypto.randomBytes(12).toString('hex') };
    this.send(res, 200, this.page(s, 'Check your payment', `<h1>Check your payment</h1>
      <div class="panel"><dl>
        <dt>Pay</dt><dd>${esc(p.payee)}</dd><dt>Sort code</dt><dd>${esc(p.sortCode)}</dd><dt>Account number</dt><dd>${esc(p.accountNumber)}</dd>
        <dt>Reference</dt><dd>${esc(p.reference || '–')}</dd><dt>Amount</dt><dd><b>${this.money(p.amount)}</b></dd><dt>When</dt><dd>Today</dd></dl>
        <form method="post" action="/pay/confirm"><input type="hidden" name="csrf" value="${esc(s.csrf)}"><input type="hidden" name="token" value="${esc(s.pending.token)}">
        <div class="actions"><button>Confirm payment</button><a class="btn alt" href="/pay">Change</a></div></form></div>`, '/pay'));
  }

  payConfirm(res, s, body) {
    const p = s.pending;
    if (!p || body.token !== p.token) return this.redirect(res, '/pay');
    s.pending = null;
    // Funds may have changed since the review page.
    const [ok, error] = this.check({ ...p, amount: (p.amount / 100).toFixed(2) });
    if (error) return this.payForm(res, s, ok, error);
    const t = this.api.pay({ ...ok, by: s.user.username });
    this.send(res, 200, this.page(s, 'Payment sent', `<h1>Payment sent</h1>
      <div class="msg ok">${this.money(ok.amount)} is on its way to ${esc(ok.payee)}.</div>
      <div class="panel"><dl><dt>Confirmation number</dt><dd>${esc(t.id.slice(0, 8).toUpperCase())}</dd><dt>Date</dt><dd>${esc(fmtDay(t.date))}</dd>
        <dt>Shows on your statement as</dt><dd>${esc(t.description)}</dd><dt>New balance</dt><dd>${this.money(this.api.state().balance)}</dd></dl>
        <div class="actions"><a class="btn" href="/accounts">Back to accounts</a><a class="btn alt" href="/pay">Make another payment</a></div></div>`, '/pay'));
  }

  directDebits(res, s) {
    const dds = this.api.state().directDebits || [];
    this.send(res, 200, this.page(s, 'Direct Debits', `<h1>Direct Debits</h1>
      <div class="panel">${dds.length ? `<table><thead><tr><th>Paid to</th><th>Reference</th><th class="n">Last amount</th><th>How often</th><th>Next payment</th></tr></thead><tbody>${dds.map((d) => `<tr>
        <td>${esc(d.payee)}</td><td>${esc(d.reference || '')}</td><td class="n">${this.money(d.amount)}</td><td>${esc(d.frequencyLabel)}</td><td>${esc(fmtDay(d.nextDate))}</td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">You have no Direct Debits on this account.</p>'}
        <p class="muted small">To cancel a Direct Debit, please contact us.</p></div>`, '/direct-debits'));
  }

  statementsPage(res, s, url, error) {
    const st = this.api.state();
    const from = validDate(url && url.searchParams.get('from')) ? url.searchParams.get('from') : `${st.today.slice(0, 8)}01`;
    const to = validDate(url && url.searchParams.get('to')) ? url.searchParams.get('to') : st.today;
    this.send(res, error ? 400 : 200, this.page(s, 'Statements', `<h1>Statements</h1>${error ? `<div class="msg err">${esc(error)}</div>` : ''}
      <form class="panel" method="get" action="/statements/download">
        <p class="muted small">Download a statement for Business Current Account ${esc(st.account.accountNumber)}.</p>
        <div class="grid"><div><label for="from">From</label><input id="from" name="from" type="date" required value="${esc(from)}"></div>
          <div><label for="to">To</label><input id="to" name="to" type="date" required value="${esc(to)}"></div>
          <div><label for="format">Format</label><select id="format" name="format"><option value="pdf">PDF statement</option><option value="csv">CSV (spreadsheet)</option></select></div></div>
        <div class="actions"><button>Download</button></div></form>`, '/statements'));
  }

  async download(res, s, url) {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!validDate(from) || !validDate(to) || from > to) return this.statementsPage(res, s, url, 'Choose a start date on or before the end date.');
    const st = this.api.state();
    const last4 = String(st.account.accountNumber).slice(-4);
    this.api.log('info', `Online banking: ${s.user.username} downloaded a ${url.searchParams.get('format') === 'csv' ? 'CSV' : 'PDF'} statement (${from} to ${to}).`);
    if (url.searchParams.get('format') === 'csv') {
      const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      const lines = [['Date', 'Description', 'Paid out', 'Paid in', 'Balance'].join(',')];
      for (const t of [...st.transactions].reverse().filter((x) => x.date >= from && x.date <= to)) {
        // Leading = + - @ would make spreadsheets treat a cell as a formula.
        const desc = /^[=+\-@]/.test(t.description) ? `'${t.description}` : t.description;
        lines.push([t.date, cell(desc), t.amount < 0 ? (-t.amount / 100).toFixed(2) : '', t.amount > 0 ? (t.amount / 100).toFixed(2) : '', (t.balance / 100).toFixed(2)].join(','));
      }
      return this.send(res, 200, `${lines.join('\r\n')}\r\n`, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="Transactions ${from} to ${to} (${last4}).csv"` });
    }
    const pdf = await this.api.statement(from, to);
    this.send(res, 200, pdf.content, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${pdf.filename.replace(/"/g, '')}"` });
  }
}

module.exports = { WebBank };
