'use strict';
// HTML email composition: escaping, lists, per-sender styles, era fonts, quoting,
// and real multipart/alternative messages over SMTP.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SMTPServer } = require('smtp-server');
const ROOT = path.join(__dirname, '..');
const { simpleParser } = require(ROOT + '/node_modules/mailparser');
const nodemailer = require(ROOT + '/node_modules/nodemailer');
const { compose, textToHtml, styleFor } = require(ROOT + '/src/core/compose');
const { stripQuoted } = require(ROOT + '/src/core/engine');
const ai = require(ROOT + '/src/core/ai');
const { Store } = require(ROOT + '/src/core/store');
const { Engine } = require(ROOT + '/src/core/engine');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Find sender addresses that get each quoting style (styles are stable per address).
const senderWith = (style, year) => {
  for (let i = 0; ; i++) if (styleFor(`p${i}@x.local`, year).quoteStyle === style) return { email: `p${i}@x.local` };
};
const PREV = { messageId: '<m1@x>', from: 'ann@co.local', fromName: 'Ann Accounts', to: ['carl@bright.local'], cc: ['sam@co.local'],
  subject: 'RE: Order', body: 'Price is £12.50 each.\nDelivery Tuesday.', date: new Date('2026-10-06T10:30:00').toISOString() };
const names = { 'carl@bright.local': 'Carl Customer', 'sam@co.local': 'Sam Sales' };

(async () => {
  // 1. Escaping: model output can never inject markup.
  const evil = 'Hi <b>there</b> <img src=x onerror=alert(1)>\n"><script>alert(1)</script> & co';
  const h = textToHtml(evil);
  assert.doesNotMatch(h, /<(b|img|script)[\s>]/i);
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(h, /&quot;&gt;&lt;script&gt;/);
  assert.match(h, /&amp; co/);
  console.log('OK 1: text is fully escaped in HTML');

  // 2. Structure: lines, blank lines, bullet and numbered lists.
  const s = textToHtml('Hi Sarah,\n\nCould you quote for:\n- 24 profiles\n- 12 floods\n\n3. third\n4. fourth\nThanks');
  assert.match(s, /<div>Hi Sarah,<\/div>\n<div><br><\/div>/);
  assert.match(s, /<ul [^>]*><li>24 profiles<\/li><li>12 floods<\/li><\/ul>/);
  assert.match(s, /<ol start="3" [^>]*><li>third<\/li><li>fourth<\/li><\/ol>/);
  assert.match(s, /<div>Thanks<\/div>$/);
  console.log('OK 2: paragraphs, spacing and lists');

  // 3. Styles are stable per sender, vary between senders, and fit the era.
  assert.deepStrictEqual(styleFor('helen@x.local', 2005), styleFor('HELEN@x.local', 2005));
  const fonts2005 = new Set(), fontsNow = new Set(), quotes = new Set();
  for (let i = 0; i < 300; i++) {
    fonts2005.add(styleFor(`u${i}@x.local`, 2005).font.family);
    fontsNow.add(styleFor(`u${i}@x.local`, null).font.family);
    quotes.add(styleFor(`u${i}@x.local`, null).quoteStyle);
  }
  assert.ok(![...fonts2005].some((f) => /Calibri|Segoe|Aptos/.test(f)), 'no post-2005 fonts in 2005: ' + [...fonts2005]);
  assert.ok(fonts2005.size >= 4 && [...fontsNow].some((f) => /Calibri/.test(f)));
  assert.deepStrictEqual([...quotes].sort(), ['outlook', 'wrote']);
  console.log(`OK 3: per-sender styles; 2005 fonts: ${[...fonts2005].map((f) => f.split(',')[0]).join(', ')}`);

  // 4. Font family with spaces stays inside the style attribute.
  for (const f of [...fonts2005, ...fontsNow]) {
    const sender = { email: [...Array(400).keys()].map((i) => `u${i}@x.local`).find((e) => styleFor(e, 2005).font.family === f || styleFor(e, null).font.family === f) };
    const { html } = compose({ body: 'x', sender, year: styleFor(sender.email, 2005).font.family === f ? 2005 : null });
    const m = html.match(/<div style="([^"]*)">/);
    assert.ok(m && /font-family:.*;font-size:\d+pt;color:#000000$/.test(m[1]), 'style attribute intact for ' + f);
  }
  console.log('OK 4: every font renders a valid style attribute');

  // 5. Outlook-style quoting, both parts; dates on the scenario clock.
  const o = compose({ body: 'Thanks Ann.', sender: senderWith('outlook', 2005), quoted: PREV, year: 2005, nameOf: (e) => names[e] });
  assert.match(o.text, /^Thanks Ann\.\n\n-----Original Message-----\nFrom: Ann Accounts <ann@co\.local>\nSent: \w+, \d+ \w+ 2005 at 10:30\nTo: Carl Customer <carl@bright\.local>\nCc: Sam Sales <sam@co\.local>\nSubject: RE: Order\n\nPrice is £12\.50 each\./);
  assert.match(o.html, /border-top:solid #B5C4DF[\s\S]*<b>From:<\/b> Ann Accounts &lt;ann@co\.local&gt;[\s\S]*<b>Sent:<\/b> \w+, \d+ \w+ 2005[\s\S]*<b>Cc:<\/b> Sam Sales[\s\S]*<div>Price is £12\.50 each\.<\/div>/);
  assert.strictEqual(stripQuoted(o.text), 'Thanks Ann.', 'our own quoting is stripped again on the way in');
  console.log('OK 5: Outlook-style quote in text and HTML');

  // 6. "On … wrote:" quoting.
  const w = compose({ body: 'Thanks Ann.', sender: senderWith('wrote', null), quoted: PREV, nameOf: (e) => names[e] });
  assert.match(w.text, /On \w+, \d+ \w+ 2026 at 10:30, Ann Accounts <ann@co\.local> wrote:\n> Price is £12\.50 each\.\n> Delivery Tuesday\.$/);
  assert.match(w.html, /wrote:<\/div>\n<blockquote style="[^"]*border-left[^"]*">[\s\S]*Delivery Tuesday\.[\s\S]*<\/blockquote>/);
  assert.strictEqual(stripQuoted(w.text), 'Thanks Ann.');
  console.log('OK 6: "On … wrote:" quote in text and HTML');

  // 7. Plain-text format has no HTML part.
  const t = compose({ body: 'Plain.', sender: { email: 'a@x.local' }, quoted: PREV, format: 'text' });
  assert.strictEqual(t.html, undefined);
  assert.match(t.text, /^Plain\./);
  console.log('OK 7: plain-text format');

  // 8. End to end over SMTP: multipart/alternative by default, text-only when chosen.
  ai.writeCustomerEmail = async () => ({ to: 'ann@co.local', cc: [], subject: 'Quote please', body: 'Hi Ann,\n\nPlease quote for:\n- 24 profiles\n- 12 floods\n\nCarl' });
  ai.writeCustomerReply = async () => ({ shouldReply: true, body: 'Thanks, that works.\n\nCarl', expectsResponse: false });
  const captured = [];
  const sink = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], onData(stream, sess, cb) {
    const ch = []; stream.on('data', (c) => ch.push(c)); stream.on('end', () => { captured.push(Buffer.concat(ch)); cb(); });
  } });
  await new Promise((r) => sink.listen(2588, '127.0.0.1', r));
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'html-')), null);
  store.setSettings({ ...store.settings, openai: { apiKey: 'x', model: 'm' },
    mail: { ...store.settings.mail, host: '127.0.0.1', smtpPort: 2588, smtpSecurity: 'none' },
    listener: { ...store.settings.listener, bindAddress: '127.0.0.1', port: 2589, offerStartTls: false },
    scenario: { ...store.settings.scenario, replyDelayMinSec: 0, replyDelayMaxSec: 0, followUpEnabled: false, minIntervalMin: 600, maxIntervalMin: 600 } });
  assert.strictEqual(store.settings.scenario.emailFormat, 'html', 'HTML is the default');
  store.setCompany({ name: 'Co', domain: 'co.local', description: 'd', employees: [{ name: 'Ann Accounts', email: 'ann@co.local', role: 'Accounts' }] });
  store.setCustomers([{ name: 'Carl Customer', email: 'carl@bright.local', organisation: 'Bright', role: 'Buyer' }]);
  const engine = new Engine(store);
  await engine.openListener();
  await engine.start();

  await engine.sendNow();
  const raw1 = captured[0].toString();
  assert.match(raw1, /Content-Type: multipart\/alternative/i);
  const m1 = await simpleParser(captured[0]);
  assert.match(m1.html, /<ul [^>]*><li>24 profiles<\/li><li>12 floods<\/li><\/ul>/);
  assert.match(m1.text, /- 24 profiles\n- 12 floods/);
  const rec1 = Object.values(store.data.threads)[0].messages[0];
  assert.strictEqual(rec1.body, 'Hi Ann,\n\nPlease quote for:\n- 24 profiles\n- 12 floods\n\nCarl', 'stored body is the plain text');

  const t2 = nodemailer.createTransport({ host: '127.0.0.1', port: 2589, ignoreTLS: true });
  await t2.sendMail({ from: 'Ann Accounts <ann@co.local>', to: 'carl@bright.local', subject: 'RE: Quote please', messageId: '<ann-1@co.local>',
    inReplyTo: m1.messageId, text: 'Quote attached, £812 total.', html: '<p>Quote attached, <b>£812</b> total.</p>' });
  t2.close();
  await wait(2000);
  const m2 = await simpleParser(captured[1]);
  assert.ok(m2.html, 'reply is HTML too');
  assert.match(m2.text, /Thanks, that works\./);
  assert.match(m2.text, /(-----Original Message-----|wrote:)[\s\S]*Quote attached, £812 total\./, 'quotes the employee\'s message');
  assert.match(m2.html, /Quote attached, £812 total\./);
  console.log('OK 8: SMTP messages are multipart/alternative (HTML + text), replies quote correctly');

  store.settings.scenario.emailFormat = 'text';
  await engine.sendNow();
  const m3 = await simpleParser(captured[2]);
  assert.strictEqual(m3.html, false);
  assert.doesNotMatch(captured[2].toString(), /text\/html/i);
  console.log('OK 9: plain-text setting sends text only');

  await engine.shutdown();
  sink.close();
  console.log('ALL PASSED');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
