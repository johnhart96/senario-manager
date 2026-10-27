'use strict';

// The virtual company's bank account: money formatting, balances and PDF statements.
//
// data.bank = {
//   account: { bankName, accountName, sortCode, accountNumber, currency, openingBalance, openedOn },
//   transactions: [{ id, date: 'YYYY-MM-DD' (scenario date), amount, description, reference,
//                    counterparty, customer?, invoice? }],
// }
// Amounts are whole minor units (pence, cents): positive is money in, negative money out.

const FASTER_PAYMENTS_YEAR = 2008; // UK Faster Payments launched in May 2008

const DEFAULT_ACCOUNT = {
  bankName: 'Northern Counties Bank',
  accountName: '',
  sortCode: '40-12-76',
  accountNumber: '31926819',
  currency: 'GBP',
  openingBalance: 0,
  openedOn: '',
};

const toMinor = (n) => Math.round(Number(String(n).replace(/[^\d.-]/g, '')) * 100);

function money(minor, currency = 'GBP', { sign = false } = {}) {
  const v = (Number(minor) || 0) / 100;
  let s;
  try {
    s = new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(Math.abs(v));
  } catch {
    s = `${currency} ${Math.abs(v).toFixed(2)}`;
  }
  return v < 0 ? `-${s}` : sign && v > 0 ? `+${s}` : s;
}

const isoDate = (d) => new Date(d).toISOString().slice(0, 10);

// Transactions oldest first, each with the balance after it.
function ledger(bank) {
  const account = { ...DEFAULT_ACCOUNT, ...(bank && bank.account) };
  let balance = Number(account.openingBalance) || 0;
  const rows = [...((bank && bank.transactions) || [])]
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.date === b.t.date ? a.i - b.i : a.t.date < b.t.date ? -1 : 1))
    .map(({ t }) => {
      balance += Number(t.amount) || 0;
      return { ...t, balance };
    });
  return { account, rows, balance };
}

// "BGC BRIGHT FOODS LTD INV-1042": how a bank shows a credit, by era.
function creditDescription(payer, reference, year) {
  const code = year && year < FASTER_PAYMENTS_YEAR ? 'BGC' : 'FPI';
  return `${code} ${String(payer || '').toUpperCase().slice(0, 30)}${reference ? ` ${String(reference).toUpperCase().slice(0, 18)}` : ''}`.trim();
}

const winAnsi = (t) => String(t)
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
  .replace(/…/g, '...').replace(/[^\x20-\x7E\xA0-\xFF€£]/g, '');

const fmtDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

// A statement for [from, to] (inclusive, 'YYYY-MM-DD'), as a PDF and as text.
async function statement(bank, { from, to, companyName, now }) {
  const { account, rows } = ledger(bank);
  const cur = account.currency;
  const before = rows.filter((r) => r.date < from);
  const inPeriod = rows.filter((r) => r.date >= from && r.date <= to);
  const opening = before.length ? before[before.length - 1].balance : Number(account.openingBalance) || 0;
  const closing = inPeriod.length ? inPeriod[inPeriod.length - 1].balance : opening;
  const paidIn = inPeriod.filter((r) => r.amount > 0).reduce((n, r) => n + r.amount, 0);
  const paidOut = inPeriod.filter((r) => r.amount < 0).reduce((n, r) => n - r.amount, 0);
  const holder = account.accountName || companyName || '';
  const last4 = String(account.accountNumber).slice(-4);

  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  doc.setTitle(`Statement ${fmtDay(from)} to ${fmtDay(to)}`);
  doc.setAuthor(account.bankName);
  doc.setCreationDate(now || new Date());
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28; const H = 841.89; const M = 45;
  const brand = rgb(0.05, 0.27, 0.36);
  const grey = rgb(0.4, 0.4, 0.4);
  let page; let y; let pageNo = 0;
  const text = (t, x, size = 9, f = font, color = rgb(0, 0, 0)) => page.drawText(winAnsi(t), { x, y, size, font: f, color });
  const right = (t, x, size = 9, f = font) => text(t, x - f.widthOfTextAtSize(winAnsi(t), size), size, f);
  const cols = { date: M, desc: M + 68, out: W - M - 170, in: W - M - 85, bal: W - M };

  const header = () => {
    page = doc.addPage([W, H]);
    pageNo += 1;
    y = H - M;
    page.drawRectangle({ x: 0, y: H - 70, width: W, height: 70, color: brand });
    page.drawText(winAnsi(account.bankName), { x: M, y: H - 42, size: 18, font: bold, color: rgb(1, 1, 1) });
    page.drawText('Business Current Account Statement', { x: M, y: H - 58, size: 9, font, color: rgb(0.85, 0.92, 0.95) });
    y = H - 100;
    text(holder, M, 11, bold); right(`Page ${pageNo}`, W - M, 8, font); y -= 14;
    text(`Sort code ${account.sortCode}   Account number ${account.accountNumber}`, M, 9, font, grey); y -= 12;
    text(`Statement period ${fmtDay(from)} to ${fmtDay(to)}`, M, 9, font, grey); y -= 22;
    page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: rgb(0.9, 0.94, 0.95) });
    text('Date', cols.date + 3, 8, bold); text('Description', cols.desc, 8, bold);
    right('Paid out', cols.out, 8, bold); right('Paid in', cols.in, 8, bold); right('Balance', cols.bal - 3, 8, bold);
    y -= 18;
  };
  const line = (date, desc, out, inn, bal, f = font) => {
    if (y < M + 40) header();
    text(date, cols.date + 3, 8.5, f);
    let d = winAnsi(desc);
    while (d && font.widthOfTextAtSize(d, 8.5) > cols.out - cols.desc - 70) d = d.slice(0, -1);
    text(d, cols.desc, 8.5, f);
    if (out) right(out, cols.out, 8.5, f);
    if (inn) right(inn, cols.in, 8.5, f);
    right(bal, cols.bal - 3, 8.5, f);
    y -= 13;
    page.drawLine({ start: { x: M, y: y + 9 }, end: { x: W - M, y: y + 9 }, thickness: 0.3, color: rgb(0.85, 0.85, 0.85) });
  };
  const amt = (minor) => money(Math.abs(minor), cur).replace(/^[^\d]+/, '');

  header();
  line(fmtDay(from), 'BALANCE BROUGHT FORWARD', '', '', money(opening, cur), bold);
  for (const r of inPeriod) {
    line(fmtDay(r.date), r.description, r.amount < 0 ? amt(r.amount) : '', r.amount > 0 ? amt(r.amount) : '', money(r.balance, cur));
  }
  line(fmtDay(to), 'BALANCE CARRIED FORWARD', '', '', money(closing, cur), bold);

  y -= 16;
  if (y < M + 70) header();
  const summary = [['Opening balance', opening], ['Money in', paidIn], ['Money out', paidOut], ['Closing balance', closing]];
  for (const [k, v] of summary) {
    text(k, W - M - 200, 9, k.startsWith('Closing') ? bold : font);
    right(money(v, cur), W - M - 3, 9, k.startsWith('Closing') ? bold : font);
    y -= 13;
  }
  y = M;
  text(`${account.bankName}. Please check this statement and tell us about anything you don't recognise.`, M, 7, font, grey);

  const content = Buffer.from(await doc.save());
  const textVersion = [
    `${account.bankName} - Business Current Account Statement`,
    `${holder}, sort code ${account.sortCode}, account ${account.accountNumber}`,
    `Period ${fmtDay(from)} to ${fmtDay(to)}`,
    `Opening balance ${money(opening, cur)}`,
    ...inPeriod.map((r) => `${fmtDay(r.date)}\t${r.description}\t${money(r.amount, cur, { sign: true })}\t${money(r.balance, cur)}`),
    `Money in ${money(paidIn, cur)}, money out ${money(paidOut, cur)}`,
    `Closing balance ${money(closing, cur)}`,
  ].join('\n');
  const filename = `Statement ${from} to ${to} (${last4}).pdf`;
  return {
    filename,
    content,
    contentType: 'application/pdf',
    summary: { opening, closing, paidIn, paidOut, count: inPeriod.length },
    record: { filename, contentType: 'application/pdf', size: content.length, kind: 'pdf', status: 'ok', text: textVersion, truncated: false, sent: true },
  };
}

module.exports = { DEFAULT_ACCOUNT, money, toMinor, ledger, creditDescription, statement, isoDate };
