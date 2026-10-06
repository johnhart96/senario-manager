'use strict';

// Builds the outgoing email body: a plain-text part and (by default) an HTML part,
// the way real mail clients send them. The AI only ever writes plain text; this
// module turns it into HTML itself, escaping everything, so model output can never
// inject markup.
//
// Each sender gets a stable "mail client personality" (font and quoting style), so
// the same customer always looks the same, and different customers look different.

const crypto = require('crypto');
const clock = require('./clock');

// Fonts by era. Calibri arrived with Office 2007 and Aptos with Office in 2023.
// Multi-word names use single quotes: they sit inside a style="…" attribute.
const FONTS = [
  { family: 'Arial, Helvetica, sans-serif', size: '10pt', from: 1980 },
  { family: 'Tahoma, Geneva, sans-serif', size: '10pt', from: 1995 },
  { family: 'Verdana, Geneva, sans-serif', size: '10pt', from: 1996 },
  { family: "'Times New Roman', Times, serif", size: '12pt', from: 1980, until: 2012 },
  { family: "'Trebuchet MS', Helvetica, sans-serif", size: '10pt', from: 1996, until: 2010 },
  { family: 'Calibri, Arial, sans-serif', size: '11pt', from: 2007 },
  { family: 'Calibri, Arial, sans-serif', size: '11pt', from: 2007 },
  { family: "'Segoe UI', Arial, sans-serif", size: '10pt', from: 2010 },
  { family: 'Aptos, Calibri, Arial, sans-serif', size: '12pt', from: 2023 },
];

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function hash(text) {
  return crypto.createHash('sha256').update(String(text).toLowerCase()).digest().readUInt32BE(0);
}

// Mail programs by era. Each sender gets one for good, which decides the identifying
// header, Message-ID shape, Outlook thread headers, quoting style and any
// "Sent from my…" line. weight = how common it is among senders.
const CLIENTS = [
  { id: 'outlook-xp', from: 2001, until: 2006, weight: 3, header: ['X-Mailer', 'Microsoft Outlook, Build 10.0.6626'], mimeOle: true, threadIndex: true, ids: 'outlook-classic', quote: 'outlook', prodId: 'Outlook 10.0' },
  { id: 'outlook-2003', from: 2003, until: 2010, weight: 6, header: ['X-Mailer', 'Microsoft Office Outlook 11'], mimeOle: true, threadIndex: true, ids: 'outlook-classic', quote: 'outlook', prodId: 'Outlook 11.0 MIMEDIR' },
  { id: 'outlook-express', from: 2001, until: 2007, weight: 3, header: ['X-Mailer', 'Microsoft Outlook Express 6.00.2900.2180'], mimeOle: true, ids: 'outlook-classic', quote: 'outlook' },
  { id: 'outlook-2007', from: 2007, until: 2012, weight: 5, header: ['X-Mailer', 'Microsoft Office Outlook 12.0'], threadIndex: true, ids: 'outlook-classic', quote: 'outlook', prodId: 'Outlook 12.0 MIMEDIR' },
  { id: 'outlook-2010', from: 2010, until: 2016, weight: 5, header: ['X-Mailer', 'Microsoft Outlook 14.0'], threadIndex: true, ids: 'hex', quote: 'outlook', prodId: 'Outlook 14.0 MIMEDIR' },
  { id: 'outlook-16', from: 2016, until: 2100, weight: 7, header: ['X-Mailer', 'Microsoft Outlook 16.0'], threadIndex: true, ids: 'hex', quote: 'outlook', prodId: 'Outlook 16.0 MIMEDIR' },
  { id: 'thunderbird-1', from: 2005, until: 2006, weight: 1, header: ['User-Agent', 'Mozilla Thunderbird 1.0.7 (Windows/20050923)'], ids: 'mozilla', quote: 'wrote' },
  { id: 'thunderbird-2', from: 2007, until: 2010, weight: 1, header: ['User-Agent', 'Thunderbird 2.0.0.23 (Windows/20090812)'], ids: 'mozilla', quote: 'wrote' },
  { id: 'thunderbird', from: 2019, until: 2100, weight: 1, header: ['User-Agent', 'Mozilla Thunderbird'], ids: 'uuid', quote: 'wrote' },
  { id: 'apple-mail-2', from: 2005, until: 2008, weight: 1, header: ['X-Mailer', 'Apple Mail (2.746.2)'], ids: 'apple', quote: 'wrote' },
  { id: 'apple-mail-4', from: 2010, until: 2013, weight: 1, header: ['X-Mailer', 'Apple Mail (2.1085)'], ids: 'apple', quote: 'wrote' },
  { id: 'apple-mail', from: 2022, until: 2100, weight: 2, header: ['X-Mailer', 'Apple Mail (2.3826.600.51.1.1)'], ids: 'apple', quote: 'wrote' },
  { id: 'lotus-notes', from: 2003, until: 2009, weight: 1, header: ['X-Mailer', 'Lotus Notes Release 6.5 September 26, 2003'], ids: 'hex', quote: 'wrote' },
  { id: 'blackberry', from: 2004, until: 2012, weight: 1, ids: 'hex', quote: 'wrote', signoff: 'Sent from my BlackBerry® wireless device' },
  { id: 'iphone', from: 2009, until: 2100, weight: 2, header: ['X-Mailer', 'iPhone Mail (21G93)'], ids: 'apple', quote: 'wrote', signoff: 'Sent from my iPhone' },
  { id: 'webmail', from: 2006, until: 2100, weight: 3, ids: 'uuid', quote: 'wrote' },
];

function weighted(list, h) {
  const total = list.reduce((n, c) => n + c.weight, 0);
  let x = h % total;
  for (const c of list) { if (x < c.weight) return c; x -= c.weight; }
  return list[0];
}

// Stable per-sender style: font, mail program and (from that) quoting style.
function styleFor(email, year) {
  const y = year || new Date().getFullYear();
  const fonts = FONTS.filter((f) => y >= f.from && (!f.until || y <= f.until));
  const clients = CLIENTS.filter((c) => y >= c.from && y <= c.until);
  const h = hash(email);
  const client = weighted(clients, h >>> 4);
  return { font: fonts[h % fonts.length], client, quoteStyle: client.quote };
}

// ---------- identifying headers ----------

const hex = (n) => crypto.randomBytes(n).toString('hex');

function messageIdFor(client, email, date) {
  const domain = email.split('@')[1] || 'localhost';
  const local = (email.split('@')[0] || 'user').replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();
  switch (client.ids) {
    case 'outlook-classic': // <000001c5c8f2$3e8d2c40$6401a8c0@HMARSHPC>
      return `<000001c${hex(3).slice(0, 5)}$${hex(4)}$${hex(4)}@${local || 'OFFICE'}PC>`;
    case 'mozilla': // <43425F1A.6070102@riversidetheatre.local>
      return `<${Math.floor(date.getTime() / 1000).toString(16).toUpperCase()}.${crypto.randomInt(1000000, 10000000)}@${domain}>`;
    case 'apple':
      return `<${crypto.randomUUID().toUpperCase()}@${domain}>`;
    case 'hex':
      return `<${hex(16).toUpperCase()}@${domain}>`;
    default:
      return `<${crypto.randomUUID()}@${domain}>`;
  }
}

// Outlook Thread-Index: 22-byte header (6 bytes of FILETIME + a GUID), plus 5 bytes
// per reply. Clients use it to group conversations.
function threadIndexFor(date, parent) {
  const filetime = (BigInt(date.getTime()) + 11644473600000n) * 10000n;
  if (!parent) {
    const ft = Buffer.alloc(8);
    ft.writeBigUInt64BE(filetime);
    return Buffer.concat([ft.subarray(0, 6), crypto.randomBytes(16)]).toString('base64');
  }
  const base = Buffer.from(parent, 'base64');
  const parentTime = BigInt('0x' + base.subarray(0, 6).toString('hex')) << 16n;
  const delta = filetime > parentTime ? (filetime - parentTime) >> 18n : 0n;
  const child = Buffer.alloc(5);
  child.writeUInt32BE(Number(delta & 0x7fffffffn), 0);
  child[4] = crypto.randomInt(0, 256);
  return Buffer.concat([base, child]).toString('base64');
}

/**
 * Headers a real client would add. Returns { messageId, headers, threadIndex }.
 * threadIndex: the conversation's base Thread-Index (null for a new conversation).
 */
// RFC 5322 date in local time with the local offset, as mail programs write it
// ("Tue, 4 Oct 2005 10:30:00 +0100"), rather than UTC.
function rfc2822(d) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
}

// Bulk senders (newsletters, automated notifications) use mailing software, not a
// desktop mail program.
function bulkMailer(year) {
  const y = year || new Date().getFullYear();
  if (y < 2010) return 'PHPMailer [version 1.73]';
  if (y < 2018) return 'PHPMailer 5.2.14 (https://github.com/PHPMailer/PHPMailer)';
  return 'PHPMailer 6.9.1 (https://github.com/PHPMailer/PHPMailer)';
}

function mailHeaders({ sender, year, date = new Date(), subject = '', threadIndex = null, bulk = null }) {
  if (bulk) {
    const domain = sender.email.split('@')[1] || 'localhost';
    return {
      messageId: `<${hex(16)}@${domain}>`,
      headers: bulk === 'newsletter' ? { 'X-Mailer': bulkMailer(year) } : {},
      threadIndex: null,
      client: null,
    };
  }
  const { client } = styleFor(sender.email, year);
  const headers = {};
  if (client.header) headers[client.header[0]] = client.header[1];
  if (client.mimeOle) headers['X-MimeOLE'] = 'Produced By Microsoft MimeOLE V6.00.2900.2180';
  let base = threadIndex;
  if (client.threadIndex) {
    const own = threadIndexFor(date, threadIndex);
    headers['Thread-Topic'] = String(subject).replace(/^\s*((re|fw|fwd|aw)\s*:\s*)+/i, '').trim();
    headers['Thread-Index'] = own;
    if (!base) base = own;
  }
  return { messageId: messageIdFor(client, sender.email, date), headers, threadIndex: base, client };
}

// ---------- plain text → HTML ----------

const BULLET = /^\s*[-*•·]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,2})[.)]\s+(.*)$/;

// Lines become <div>s (as Outlook/Gmail compose them), blank lines become spacer
// divs, and runs of "- item" / "1. item" lines become real lists.
function textToHtml(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; ) {
    const bullet = BULLET.exec(lines[i]);
    const numbered = NUMBERED.exec(lines[i]);
    if (bullet || numbered) {
      const re = bullet ? BULLET : NUMBERED;
      const tag = bullet ? 'ul' : 'ol';
      const items = [];
      while (i < lines.length && re.exec(lines[i])) {
        const m = re.exec(lines[i]);
        items.push(`<li>${esc(bullet ? m[1] : m[2])}</li>`);
        i++;
      }
      const start = numbered && numbered[1] !== '1' ? ` start="${Number(numbered[1])}"` : '';
      out.push(`<${tag}${start} style="margin:0 0 0 24px;padding:0">${items.join('')}</${tag}>`);
      continue;
    }
    out.push(lines[i].trim() === '' ? '<div><br></div>' : `<div>${esc(lines[i])}</div>`);
    i++;
  }
  return out.join('\n');
}

// ---------- quoting the previous message ----------

function sentDate(date, year) {
  return clock.toScenario(date, year).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });
}

const who = (name, email) => (name ? `${name} <${email}>` : email);

function quoteText(prev, style, { year, nameOf }) {
  if (style === 'outlook') {
    return [
      '',
      '',
      '-----Original Message-----',
      `From: ${who(prev.fromName, prev.from)}`,
      `Sent: ${sentDate(prev.date, year)}`,
      `To: ${prev.to.map((e) => who(nameOf(e), e)).join('; ')}`,
      ...(prev.cc && prev.cc.length ? [`Cc: ${prev.cc.map((e) => who(nameOf(e), e)).join('; ')}`] : []),
      `Subject: ${prev.subject}`,
      '',
      prev.body,
    ].join('\n');
  }
  const body = prev.body.split('\n').map((l) => '> ' + l).join('\n');
  return `\n\nOn ${sentDate(prev.date, year)}, ${who(prev.fromName, prev.from)} wrote:\n${body}`;
}

function quoteHtml(prev, style, { year, nameOf }) {
  const list = (arr) => arr.map((e) => esc(who(nameOf(e), e))).join('; ');
  if (style === 'outlook') {
    return `
<div><br></div>
<div style="border:none;border-top:solid #B5C4DF 1.0pt;padding:3.0pt 0 0 0">
<div><b>From:</b> ${esc(who(prev.fromName, prev.from))}<br>
<b>Sent:</b> ${esc(sentDate(prev.date, year))}<br>
<b>To:</b> ${list(prev.to)}<br>${prev.cc && prev.cc.length ? `\n<b>Cc:</b> ${list(prev.cc)}<br>` : ''}
<b>Subject:</b> ${esc(prev.subject)}</div>
</div>
<div><br></div>
${textToHtml(prev.body)}`;
  }
  return `
<div><br></div>
<div>On ${esc(sentDate(prev.date, year))}, ${esc(who(prev.fromName, prev.from))} wrote:</div>
<blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex">
${textToHtml(prev.body)}
</blockquote>`;
}

/**
 * Compose an outgoing email.
 *   body     — the new text written by the AI (plain text)
 *   sender   — { email } of the customer/party, for their stable style
 *   quoted   — the message being replied to (thread record), or null
 *   format   — 'html' (HTML + plain-text alternative) or 'text'
 *   year     — operating year, for fonts and quoted dates
 *   nameOf   — email → display name, for quoted To/Cc lines
 * Returns { text, html } (html is undefined for 'text').
 */
// Optional page layouts for automated mail: 'newsletter' (branded header, "## "
// lines become section headings, unsubscribe footer) and 'notification' (boxed
// system message with a do-not-reply footer).
function layoutHtml(layout, inner, sender, family, size) {
  const org = esc(sender.organisation || sender.name || '');
  if (layout === 'newsletter') {
    return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f2;padding:16px 0"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;font-family:${family};font-size:${size};color:#222222">
<tr><td style="background:#1f3864;color:#ffffff;padding:18px 24px;font-size:20px;font-weight:bold">${org}</td></tr>
<tr><td style="padding:20px 24px">${inner}</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid #dddddd;font-size:11px;color:#777777">You are receiving this email because you are a customer or subscriber of ${org}.<br>To unsubscribe, reply with &quot;unsubscribe&quot; in the subject line.</td></tr>
</table></td></tr></table>`;
  }
  if (layout === 'notification') {
    return `<div style="font-family:${family};font-size:${size};color:#222222;max-width:640px;border:1px solid #d0d0d0;padding:16px 20px">
<div style="font-weight:bold;color:#1f3864;margin-bottom:10px">${org}</div>
${inner}
<div style="margin-top:16px;font-size:11px;color:#777777">This is an automated message. Please do not reply to this email.</div>
</div>`;
  }
  return null;
}

/**
 * Compose an outgoing email.
 *   body     — the new text written by the AI (plain text)
 *   sender   — { email, name?, organisation? } of the customer/party, for their stable style
 *   quoted   — the message being replied to (thread record), or null
 *   format   — 'html' (HTML + plain-text alternative) or 'text'
 *   year     — operating year, for fonts, mail program and quoted dates
 *   nameOf   — email → display name, for quoted To/Cc lines
 *   layout   — optional 'newsletter' or 'notification'
 * Returns { text, html } (html is undefined for 'text').
 */
function compose({ body, sender, quoted = null, format = 'html', year = null, nameOf = () => '', layout = null }) {
  const style = styleFor(sender.email, year);
  let clean = String(body || '').replace(/\r\n/g, '\n').trim();
  if (style.client.signoff && !layout && !clean.includes(style.client.signoff)) clean += `\n\n${style.client.signoff}`;
  const text = clean.replace(/^## /gm, '') + (quoted ? quoteText(quoted, style.quoteStyle, { year, nameOf }) : '');
  if (format === 'text') return { text };
  const { family, size } = style.font;
  const inner = layout === 'newsletter'
    ? textToHtml(clean).replace(/<div>## (.*?)<\/div>/g, '<div style="font-size:16px;font-weight:bold;color:#1f3864;margin:14px 0 6px">$1</div>')
    : textToHtml(clean);
  const laidOut = layout ? layoutHtml(layout, inner, sender, family, size) : null;
  const html = `<!DOCTYPE html>
<html>
<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head>
<body>
${laidOut || `<div style="font-family:${family};font-size:${size};color:#000000">
${inner}${quoted ? quoteHtml(quoted, style.quoteStyle, { year, nameOf }) : ''}
</div>`}
</body>
</html>`;
  return { text, html };
}

module.exports = { compose, textToHtml, styleFor, mailHeaders, rfc2822, CLIENTS };
