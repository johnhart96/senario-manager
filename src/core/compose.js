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

// Stable per-sender style: font, and whether they quote Outlook-style or "On … wrote:".
function styleFor(email, year) {
  const y = year || new Date().getFullYear();
  const fonts = FONTS.filter((f) => y >= f.from && (!f.until || y <= f.until));
  const h = hash(email);
  return {
    font: fonts[h % fonts.length],
    quoteStyle: (h >>> 8) % 10 < 6 ? 'outlook' : 'wrote',
  };
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
function compose({ body, sender, quoted = null, format = 'html', year = null, nameOf = () => '' }) {
  const style = styleFor(sender.email, year);
  const clean = String(body || '').replace(/\r\n/g, '\n').trim();
  const text = clean + (quoted ? quoteText(quoted, style.quoteStyle, { year, nameOf }) : '');
  if (format === 'text') return { text };
  const { family, size } = style.font;
  const html = `<!DOCTYPE html>
<html>
<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head>
<body>
<div style="font-family:${family};font-size:${size};color:#000000">
${textToHtml(clean)}${quoted ? quoteHtml(quoted, style.quoteStyle, { year, nameOf }) : ''}
</div>
</body>
</html>`;
  return { text, html };
}

module.exports = { compose, textToHtml, styleFor };
