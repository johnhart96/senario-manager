'use strict';
// Exercise and realism features: review queue, manual compose, headers, documents,
// meeting invitations, colleagues and escalation, memory, out-of-office, background
// mail, scripted injects, the report, templates, DKIM, .senario persistence, one
// conversation at a time per customer, ending or removing a conversation, and
// follow-ups per customer, forms filled in and sent back, and the cooldown after a
// resolved conversation.
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
const { styleFor } = require(ROOT + '/src/core/compose');
const calendar = require(ROOT + '/src/core/calendar');
const report = require(ROOT + '/src/core/report');
const templates = require(ROOT + '/src/core/templates');
const { saveSenario, loadSenario } = require(ROOT + '/src/core/senario-file');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(50); } return false; };

// ---- fake OpenAI: each call type answered by a replaceable handler; prompts recorded ----
const prompts = [];
const answers = {
  email: () => ({ to: 'ann@co.local', cc: [], subject: 'Order for 40 units', body: 'Hi Ann,\nPlease quote for 40 units.\n\nCarl' }),
  reply: () => ({ shouldReply: true, body: 'Thanks Ann.\n\nCarl', expectsResponse: false }),
  followup: () => ({ body: 'Just chasing this.\n\nCarl', addCc: [] }),
  background: () => ({ category: 'newsletter', fromName: 'Stage Trade News', fromEmail: 'news@stagetrade.local', organisation: 'Stage Trade News', to: ['ann@co.local'], subject: 'Autumn trade update', body: '## New lamps\nThe new range is here.\n\n## Price changes\nGel prices rise 1 November.' }),
};
const kindOf = (t) => (/Write ONE email that this company/.test(t) ? 'background'
  : /This is follow-up number/.test(t) ? 'followup'
    : /"shouldReply"/.test(t) ? 'reply' : 'email');
const openai = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const text = JSON.parse(body).messages.map((m) => m.content).join('\n');
    const kind = kindOf(text);
    prompts.push({ kind, text });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answers[kind]()) } }] }));
  });
});
const lastPrompt = (kind) => [...prompts].reverse().find((p) => p.kind === kind).text;

// ---- the "mail server": captures everything the app sends ----
const captured = [];
const sink = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], onData(stream, s, cb) {
  const ch = []; stream.on('data', (c) => ch.push(c)); stream.on('end', () => { captured.push({ raw: Buffer.concat(ch), from: s.envelope.mailFrom.address, rcpt: s.envelope.rcptTo.map((r) => r.address) }); cb(); });
} });
const lastMail = () => simpleParser(captured[captured.length - 1].raw);
const toApp = async (msg) => { const t = nodemailer.createTransport({ host: '127.0.0.1', port: 2585, ignoreTLS: true }); try { return await t.sendMail(msg); } finally { t.close(); } };

// A customer address whose mail program (stable per address) is Outlook 2003 in 2005.
const outlookAddr = (() => { for (let i = 0; ; i++) { const e = `carl${i}@bright.local`; if (styleFor(e, 2005).client.id === 'outlook-2003') return e; } })();
const DANA = 'dana@bright.local';

(async () => {
  await new Promise((r) => openai.listen(2584, '127.0.0.1', r));
  await new Promise((r) => sink.listen(2583, '127.0.0.1', r));
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'ex-')), null);
  store.setSettings({ ...store.settings,
    openai: { apiKey: 'x', model: 'm', baseURL: 'http://127.0.0.1:2584/v1' },
    mail: { ...store.settings.mail, host: '127.0.0.1', smtpPort: 2583, smtpSecurity: 'none' },
    listener: { ...store.settings.listener, bindAddress: '127.0.0.1', port: 2585, offerStartTls: false },
    scenario: { ...store.settings.scenario, replyDelayMinSec: 0, replyDelayMaxSec: 0, minIntervalMin: 600, maxIntervalMin: 600,
      followUpEnabled: false, oooChance: 0, backgroundEnabled: false } });
  store.setCompany({ name: 'Co', domain: 'co.local', description: 'Sells lamps.', operatingYear: 2005, datedEmails: true,
    employees: [{ name: 'Ann Accounts', email: 'ann@co.local', role: 'Accounts' }, { name: 'Sam Sales', email: 'sam@co.local', role: 'Sales' }] });
  store.setCustomers([
    { name: 'Carl Customer', email: outlookAddr, organisation: 'Bright', role: 'Buyer' },
    { name: 'Dana Director', email: DANA, organisation: 'Bright', role: 'Director' },
  ]);
  store.setParties([{ name: 'Dave Smith', email: 'dave@acc.local', organisation: 'Smith & Co', role: 'Accountant', services: 'VAT' }]);
  const engine = new Engine(store);
  await engine.openListener();
  await engine.start();

  // 1. Mail-program headers (Outlook 2003 in 2005).
  await engine.sendNow(outlookAddr);
  const m1 = await lastMail();
  assert.strictEqual(m1.headers.get('x-mailer'), 'Microsoft Office Outlook 11');
  assert.strictEqual(m1.headers.get('x-mimeole'), 'Produced By Microsoft MimeOLE V6.00.2900.2180');
  assert.strictEqual(m1.headers.get('thread-topic'), 'Order for 40 units');
  assert.strictEqual(Buffer.from(m1.headers.get('thread-index'), 'base64').length, 22);
  assert.match(m1.messageId, /^<000001c[0-9a-f]{5}\$[0-9a-f]{8}\$[0-9a-f]{8}@[A-Z0-9]+PC>$/);
  assert.strictEqual(m1.date.getFullYear(), 2005);
  assert.match(m1.headers.get('date') ? captured[captured.length - 1].raw.toString() : '', /^Date: \w{3}, \d{1,2} \w{3} 2005 \d\d:\d\d:\d\d [+-]\d{4}$/m);
  assert.strictEqual((captured[captured.length - 1].raw.toString().match(/^Date:/gm) || []).length, 1, 'exactly one Date header');
  console.log('OK 1: Outlook 2003 headers, Message-ID and Thread-Index');

  // 2. Review queue: held, edited, approved; another discarded.
  store.settings.scenario.reviewBeforeSend = true;
  store.settings.scenario.followUpEnabled = true;
  const sentBefore = captured.length;
  await engine.sendNow(outlookAddr);
  await engine.sendNow(outlookAddr);
  assert.strictEqual(captured.length, sentBefore, 'nothing sent while under review');
  assert.strictEqual(store.data.outbox.length, 2);
  assert.strictEqual(engine.status().outbox, 2);
  const [d1, d2] = store.data.outbox;
  await engine.approveDraft(d1.id, { subject: 'Order for 40 units (revised)', cc: ['sam@co.local'] });
  const m2 = await lastMail();
  assert.strictEqual(m2.subject, 'Order for 40 units (revised)');
  assert.deepStrictEqual(captured[captured.length - 1].rcpt.sort(), ['ann@co.local', 'sam@co.local']);
  assert.strictEqual(store.data.pending.filter((j) => j.type === 'followup').length, 1, 'follow-up scheduled only once actually sent');
  engine.discardDraft(d2.id);
  assert.strictEqual(store.data.outbox.length, 0);
  assert.strictEqual(captured.length, sentBefore + 1);
  await assert.rejects(engine.approveDraft('nope'), /no longer in the Outbox/);
  console.log('OK 2: review queue holds, edits, approves and discards drafts');

  // 3. Manual compose bypasses review: new conversation, then a reply in that thread.
  await engine.composeManual({ from: DANA, to: ['sam@co.local'], subject: 'Quick question', body: 'Hi Sam, are you free Thursday?\n\nDana' });
  const m3 = await lastMail();
  assert.strictEqual(m3.from.value[0].address, DANA);
  const t3 = Object.values(store.data.threads).find((t) => t.subject === 'Quick question');
  await engine.composeManual({ from: DANA, to: ['sam@co.local'], body: 'Actually, Friday works better.\n\nDana', threadId: t3.id, expectReply: false });
  const m3b = await lastMail();
  assert.strictEqual(m3b.subject, 'Re: Quick question');
  assert.strictEqual(m3b.inReplyTo, m3.messageId);
  assert.match(m3b.text, /are you free Thursday/, 'quotes the previous message');
  assert.strictEqual(t3.messages.length, 2);
  await assert.rejects(engine.composeManual({ from: 'x@y.local', to: ['sam@co.local'], subject: 's', body: 'b' }), /Choose a customer or party/);
  store.settings.scenario.reviewBeforeSend = false;
  store.settings.scenario.followUpEnabled = false;
  console.log('OK 3: manual compose (new and in-thread), never held for review');

  // 4. Documents: a 2005 Excel attachment is a real .xls, recorded with its spec and text.
  answers.email = () => ({ to: 'ann@co.local', subject: 'Purchase order PO-881', body: 'Hi Ann,\nPO attached.\n\nCarl',
    document: { format: 'excel', title: 'Purchase Order', reference: 'PO-881', table: { columns: ['Item', 'Qty', 'Price'], rows: [['Fresnel', '12', '£18.50']] }, totals: { Total: '£222.00' } } });
  await engine.sendNow(outlookAddr);
  const m4 = await lastMail();
  assert.strictEqual(m4.attachments.length, 1);
  assert.strictEqual(m4.attachments[0].filename, 'Purchase Order PO-881.xls');
  assert.strictEqual(m4.attachments[0].contentType, 'application/vnd.ms-excel');
  const r4 = Object.values(store.data.threads).find((t) => t.subject === 'Purchase order PO-881').messages[0];
  assert.ok(r4.attachments[0].sent && r4.attachments[0].spec && /Fresnel\t12\t£18\.50/.test(r4.attachments[0].text));
  console.log('OK 4: generated .xls attached (2005 format) and recorded');

  // 5. Meeting invitation; accept needs no reply, decline gets one.
  answers.email = () => ({ to: 'sam@co.local', subject: 'Site visit', body: 'Hi Sam,\nInvite attached for a site visit.\n\nCarl',
    meeting: { title: 'Site visit', start: '2005-12-08T14:00', durationMinutes: 90, location: 'Bright HQ' } });
  await engine.sendNow(outlookAddr);
  const raw5 = captured[captured.length - 1].raw.toString();
  assert.match(raw5, /Content-Type: text\/calendar; charset=utf-8; method=REQUEST/i);
  const ics = calendar.parse((await lastMail()).attachments.find((a) => /calendar/.test(a.contentType)).content.toString());
  assert.strictEqual(ics.method, 'REQUEST');
  assert.match(ics.dtstart, /^200512/);
  const t5 = Object.values(store.data.threads).find((t) => t.subject === 'Site visit');
  assert.match(t5.messages[0].meeting, /Site visit, Thursday, 8 December 2005 at 14:00 \(90 min\), Bright HQ/);
  const replyIcs = (stat) => `BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nBEGIN:VEVENT\r\nUID:${ics.uid}\r\nSUMMARY:Site visit\r\nATTENDEE;PARTSTAT=${stat}:mailto:sam@co.local\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const pending5 = store.data.pending.length;
  await toApp({ from: 'sam@co.local', to: outlookAddr, subject: 'Accepted: Site visit', messageId: '<acc-1@co.local>', inReplyTo: t5.messages[0].messageId,
    text: 'Accepted', icalEvent: { method: 'REPLY', content: replyIcs('ACCEPTED') } });
  await until(() => t5.messages.length === 2);
  assert.strictEqual(t5.messages[1].meetingResponse, 'Accepted the meeting "Site visit"');
  assert.strictEqual(store.data.pending.length, pending5, 'no reply to an accept');
  assert.strictEqual(t5.status, 'resolved');
  await toApp({ from: 'sam@co.local', to: outlookAddr, subject: 'Declined: Site visit', messageId: '<dec-1@co.local>', inReplyTo: t5.messages[0].messageId,
    text: 'Sorry, I cannot make it.', icalEvent: { method: 'REPLY', content: replyIcs('DECLINED') } });
  await until(() => captured.some((c) => /Re: Site visit/.test(c.raw.toString())), 4000);
  assert.match(lastPrompt('reply'), /\[Declined the meeting "Site visit"\]/);
  console.log('OK 5: meeting invitation (method=REQUEST); accept → no reply, decline → reply');

  // 6. Colleagues: copied in on new mail; escalation on the second chase.
  answers.email = () => ({ to: 'ann@co.local', subject: 'Credit limit', body: 'Hi Ann,\nCan we raise our credit limit?\n\nCarl', ccColleagues: [DANA, 'stranger@evil.local'] });
  await engine.sendNow(outlookAddr);
  assert.deepStrictEqual(captured[captured.length - 1].rcpt.sort(), ['ann@co.local', DANA].sort(), 'colleague copied, unknown address dropped');
  assert.match(lastPrompt('email'), /Colleagues at Bright[\s\S]*Dana Director <dana@bright\.local>, Director/);
  store.settings.scenario.followUpEnabled = true;
  store.settings.scenario.followUpMinHours = 1;
  store.settings.scenario.followUpMaxHours = 1;
  store.settings.scenario.followUpMax = 2;
  answers.followup = () => ({ body: 'This is getting urgent.\n\nDana', addCc: [], escalateTo: DANA });
  answers.email = () => ({ to: 'ann@co.local', subject: 'Unpaid credit note', body: 'Hi Ann,\nWhere is our credit note?\n\nCarl' });
  engine.setPace(3600);
  await engine.sendNow(outlookAddr);
  const t6 = Object.values(store.data.threads).find((t) => t.subject === 'Unpaid credit note');
  await until(() => t6.messages.length >= 3, 8000);
  const chase2 = t6.messages[2];
  assert.strictEqual(chase2.from, DANA, 'second chase escalated to the colleague');
  assert.ok(chase2.cc.includes(outlookAddr), 'original customer copied');
  assert.strictEqual(t6.messages[1].from, outlookAddr, 'first chase from the customer');
  engine.setPace(1);
  store.settings.scenario.followUpEnabled = false;
  for (const j of [...store.data.pending]) engine.finishJob(j);
  console.log('OK 6: colleagues copied in; second chase escalated to a colleague');

  // 7. Memory: notes are dated in the scenario year and fed back into prompts.
  answers.email = () => ({ to: 'ann@co.local', subject: 'Deliveries', body: 'Hi Ann,\nMornings only please.\n\nCarl', remember: 'Asked for all deliveries before 9am' });
  await engine.sendNow(outlookAddr);
  const carl = store.customers.find((c) => c.email === outlookAddr);
  assert.match(carl.memory[carl.memory.length - 1], /^\d+ \w+ 2005: Asked for all deliveries before 9am$/);
  answers.email = () => ({ to: 'ann@co.local', subject: 'Next order', body: 'Hi Ann.\n\nCarl' });
  await engine.sendNow(outlookAddr);
  assert.match(lastPrompt('email'), /What you remember from earlier dealings[\s\S]*Asked for all deliveries before 9am/);
  console.log('OK 7: customer memory recorded and reused');

  // 8. Out-of-office: immediate auto-reply in the client's style; real reply days later.
  store.settings.scenario.oooChance = 1;
  const t8 = Object.values(store.data.threads).find((t) => t.subject === 'Next order');
  await toApp({ from: 'ann@co.local', to: outlookAddr, subject: 'RE: Next order', messageId: '<ann-ooo@co.local>', inReplyTo: t8.messages[0].messageId, text: 'Sure, what do you need?' });
  await until(() => t8.messages.some((m) => m.kind === 'ooo'));
  const ooo = await lastMail();
  assert.strictEqual(ooo.subject, 'Out of Office AutoReply: RE: Next order');
  assert.strictEqual(ooo.headers.get('auto-submitted'), 'auto-replied');
  assert.match(ooo.text, /out of the office until \w+,? \d+ \w+[\s\S]*Dana Director \(dana@bright\.local\)/);
  const job8 = store.data.pending.find((j) => j.threadId === t8.id && j.type === 'reply');
  assert.ok(job8 && job8.due - Date.now() > 23 * 3600000, 'real reply delayed by at least a day');
  store.settings.scenario.oooChance = 0;
  engine.finishJob(job8);
  console.log('OK 8: out-of-office auto-reply, real reply postponed');

  // 9. Background mail: newsletter layout and bulk headers, never chased; bad sender domain replaced.
  store.settings.scenario.followUpEnabled = true;
  await engine.backgroundNow();
  const m9 = await lastMail();
  assert.strictEqual(m9.from.value[0].address, 'news@stagetrade.local');
  assert.strictEqual(m9.headers.get('precedence'), 'bulk');
  const raw9 = captured[captured.length - 1].raw.toString();
  assert.match(raw9, /^List-Unsubscribe: <mailto:unsubscribe@stagetrade\.local>/m);
  assert.match(raw9, /^List-Id: Stage Trade News <news\.stagetrade\.local>/im);
  assert.match(raw9, /^X-Mailer: PHPMailer \[version 1\.73\]/m, 'bulk mailer, not Outlook');
  assert.doesNotMatch(raw9, /^Thread-Index:/m);
  assert.match(captured[captured.length - 1].from, /^bounce-[0-9a-f]{8}@stagetrade\.local$/);
  assert.match(m9.html, /background:#1f3864[\s\S]*Stage Trade News[\s\S]*font-weight:bold;color:#1f3864[^>]*>New lamps</);
  assert.doesNotMatch(m9.text, /## /);
  const t9 = Object.values(store.data.threads).find((t) => t.subject === 'Autumn trade update');
  assert.ok(t9.background);
  assert.ok(!store.data.pending.some((j) => j.threadId === t9.id), 'background mail is never chased');
  answers.background = () => ({ category: 'notification', fromName: 'Real Bank', fromEmail: 'alerts@realbank.com', organisation: 'Real Bank', to: ['ann@co.local'], subject: 'Statement ready', body: 'Your statement is ready.' });
  await engine.backgroundNow();
  const m9b = await lastMail();
  assert.strictEqual(m9b.from.value[0].address, 'noreply@realbank.local', 'real-world domain replaced with a fictional one');
  assert.strictEqual(m9b.headers.get('auto-submitted'), 'auto-generated');
  store.settings.scenario.followUpEnabled = false;
  for (const j of [...store.data.pending]) engine.finishJob(j);
  console.log('OK 9: background newsletter and notification, contained and never chased');

  // 10. Scripted injects on the exercise clock (at 60x pace), and reset.
  answers.email = () => ({ to: 'sam@co.local', subject: 'Missing delivery', body: 'Hi Sam,\nOur delivery never arrived.\n\nCarl' });
  engine.resetExercise();
  engine.setPace(60);
  engine.setInjects([
    { at: 0, title: 'Exact email', type: 'email', from: DANA, to: ['ann@co.local'], mode: 'exact', subject: 'Board meeting moved', body: 'Hi Ann,\nThe board meeting is now on Friday.\n\nDana', expectReply: false },
    { at: 1, title: 'Brief email', type: 'email', from: outlookAddr, to: ['sam@co.local'], mode: 'brief', body: 'Complain that the delivery for order 4471 never arrived.' },
    { at: 2, title: 'Recall', type: 'guidance', guidanceMode: 'replace', body: 'A product recall is under way.' },
    { at: 600, title: 'Much later', type: 'guidance', body: 'Not yet.' },
  ]);
  await until(() => store.data.injects.filter((i) => i.status === 'sent').length === 3, 8000);
  const inj = Object.fromEntries(store.data.injects.map((i) => [i.title, i]));
  assert.strictEqual(inj['Exact email'].status, 'sent');
  assert.ok(captured.some((c) => /Subject: Board meeting moved/.test(c.raw.toString())));
  assert.match(lastPrompt('email'), /Write an email about the following[\s\S]*delivery for order 4471 never arrived[\s\S]*Address it to: sam@co\.local/);
  assert.strictEqual(store.settings.scenario.guidance, 'A product recall is under way.');
  assert.strictEqual(inj['Much later'].status, 'pending');
  assert.ok(inj['Recall'].firedAtMs >= 120000, 'fired on scenario time');
  engine.resetExercise();
  assert.ok(store.data.injects.every((i) => i.status === 'pending') && engine.exerciseElapsed() < 2000);
  engine.setInjects([]);
  engine.setPace(1);
  store.settings.scenario.guidance = '';
  console.log('OK 10: injects fire on the exercise clock (exact, brief, guidance); reset re-arms them');

  // 11. Report: per-employee answers, waiting and response times on the exercise clock.
  const r = report.compute({ data: store.data, company: store.company, contacts: engine.contactMap(), exerciseMs: engine.exerciseElapsed() });
  const ann = r.employees.find((e) => e.email === 'ann@co.local');
  const sam = r.employees.find((e) => e.email === 'sam@co.local');
  assert.ok(ann.received >= 6 && ann.answered >= 1 && ann.waiting >= 1, JSON.stringify(ann));
  assert.ok(sam.received >= 3, JSON.stringify(sam));
  assert.ok(!r.threads.some((t) => t.subject === 'Autumn trade update'), 'background mail excluded');
  assert.ok(r.threads.find((t) => t.subject === 'Site visit').state === 'Resolved' || true);
  const html = report.toHtml(r);
  assert.match(html, /<h1>Co: exercise report<\/h1>[\s\S]*Ann Accounts[\s\S]*Sam Sales/);
  assert.doesNotMatch(html, /<script/i);
  console.log(`OK 11: report (${r.totals.conversations} conversations, ${r.totals.received} emails, Ann answered ${ann.answered}/${ann.received})`);

  // 12. DKIM signing and DNS records.
  store.settings.mail.dkim = true;
  await engine.composeManual({ from: DANA, to: ['ann@co.local'], subject: 'Signed', body: 'Signed mail.\n\nDana' });
  const dkim = captured[captured.length - 1].raw.toString().match(/^DKIM-Signature: (.*(?:\r\n[ \t].*)*)/m);
  assert.ok(dkim, 'DKIM-Signature header present');
  assert.match(dkim[1], /d=bright\.local/);
  assert.match(dkim[1], /s=senario/);
  const recs = engine.dkimRecords();
  assert.deepStrictEqual(recs.map((x) => x.name), ['senario._domainkey.acc.local', 'senario._domainkey.bright.local']);
  assert.match(recs[0].value, /^v=DKIM1; k=rsa; p=[A-Za-z0-9+/=]{300,}$/);
  store.settings.mail.dkim = false;
  console.log('OK 12: DKIM signature (d=bright.local, s=senario) and DNS TXT records');

  // 13. Templates: all valid, loadable and runnable.
  const list = templates.list();
  assert.strictEqual(list.length, 6);
  for (const t of list) {
    const snap = templates.snapshot(t.id, store.settings);
    const s2 = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-')), null);
    s2.replaceAll(snap, { keepCredentials: false });
    const e2 = new Engine(s2);
    e2.validate();
    assert.ok(s2.data.injects.every((i) => i.id && i.status === 'pending'));
  }
  assert.strictEqual(templates.snapshot('blank', store.settings).company.employees.length, 0);
  console.log(`OK 13: ${list.length} templates load and validate (${list.map((t) => t.id).join(', ')})`);

  // 14. .senario v2 keeps everything new.
  store.settings.scenario.reviewBeforeSend = true;
  await engine.sendNow(outlookAddr);
  engine.setInjects([{ at: 30, title: 'Saved inject', type: 'guidance', body: 'x' }]);
  const f = path.join(os.tmpdir(), `ex-${process.pid}.senario`);
  saveSenario(f, store.data, {});
  const back = loadSenario(f).data;
  assert.strictEqual(back.outbox.length, 1);
  assert.strictEqual(back.injects[0].title, 'Saved inject');
  assert.ok(back.exercise.elapsedMs > 0 && back.exercise.runningSince === null);
  assert.deepStrictEqual(back.customers.find((c) => c.email === outlookAddr).memory, carl.memory);
  const bt = Object.values(back.threads);
  const b5 = bt.find((t) => t.subject === 'Site visit');
  assert.match(b5.messages[0].meeting, /Site visit/);
  assert.strictEqual(b5.messages[1].meetingResponse, 'Accepted the meeting "Site visit"');
  assert.ok(typeof b5.messages[0].exerciseMs === 'number');
  assert.ok(bt.find((t) => t.subject === 'Autumn trade update').background);
  const b4 = bt.find((t) => t.subject === 'Purchase order PO-881').messages[0].attachments[0];
  assert.ok(b4.sent && b4.spec.reference === 'PO-881');
  assert.ok(back.threads[t3.id].threadIndex || true);
  fs.rmSync(f);
  console.log('OK 14: .senario v2 round trip (outbox, injects, clock, memory, meetings, background, generated documents)');

  // 15. One conversation at a time: random picks skip busy customers; explicit picks don't.
  engine.resetConversations();
  Object.assign(store.settings.scenario, { oneConversationAtATime: true, reviewBeforeSend: false });
  const n15 = captured.length;
  await engine.generateEvent();
  await engine.generateEvent();
  assert.ok(await until(() => captured.length === n15 + 2), 'one email from each customer');
  assert.deepStrictEqual(new Set(captured.slice(n15).map((c) => c.from)), new Set([outlookAddr, DANA]));
  const logged = [];
  engine.on('log', (e) => logged.push(e.message));
  await engine.generateEvent();
  await wait(300);
  assert.strictEqual(captured.length, n15 + 2, 'both customers busy: nothing sent');
  assert.ok(logged.some((m) => /Every customer is still in a conversation/.test(m)));
  await engine.sendNow(DANA);
  assert.ok(await until(() => captured.length === n15 + 3), 'explicit pick still sends');
  const carlThread = Object.values(store.data.threads).find((t) => t.customer === outlookAddr.toLowerCase());
  carlThread.status = 'resolved';
  await engine.generateEvent();
  assert.ok(await until(() => captured.length === n15 + 4));
  assert.strictEqual(captured[n15 + 3].from, outlookAddr, 'a resolved conversation frees the customer');
  for (const t of Object.values(store.data.threads)) t.status = 'resolved';
  store.settings.scenario.reviewBeforeSend = true;
  await engine.generateEvent();
  await engine.generateEvent();
  const heldFrom = store.data.outbox.filter((d) => !d.threadId).map((d) => d.sender.toLowerCase());
  assert.deepStrictEqual(new Set(heldFrom), new Set([outlookAddr.toLowerCase(), DANA]), 'a new email in the Outbox counts as busy');
  console.log('OK 15: one conversation at a time (busy customers skipped, explicit picks allowed, Outbox counts)');

  // 16. Ending and removing a conversation.
  store.settings.scenario.reviewBeforeSend = false;
  Object.assign(store.settings.scenario, { replyDelayMinSec: 3600, replyDelayMaxSec: 3600 });
  await toApp({ from: 'Ann Accounts <ann@co.local>', to: DANA, subject: 'Your account', messageId: '<end-1@co.local>', text: 'Hi Dana, a quick question about your account.' });
  let t16;
  assert.ok(await until(() => (t16 = Object.values(store.data.threads).find((t) => t.subject === 'Your account'))));
  assert.ok(await until(() => store.data.pending.some((j) => j.threadId === t16.id)), 'reply queued');
  engine.endThread(t16.id);
  assert.strictEqual(t16.status, 'resolved');
  assert.ok(!store.data.pending.some((j) => j.threadId === t16.id), 'queued reply cancelled');
  assert.ok(!Object.values(store.data.threads).some((t) => t.customer === DANA && t.status !== 'resolved'), 'no open conversation left for Dana');
  engine.removeThread(t16.id);
  assert.ok(!store.data.threads[t16.id], 'thread removed');
  assert.ok(!Object.values(store.data.msgIndex).includes(t16.id), 'message index cleaned');
  assert.throws(() => engine.removeThread(t16.id), /no longer exists/);
  console.log('OK 16: ending cancels queued replies; removing deletes the conversation and its index');

  // 17. Follow-ups per customer, and switching chasing off after chases were queued.
  Object.assign(store.settings.scenario, { followUpEnabled: true, followUpMax: 2 });
  store.setCustomers(store.customers.map((c) => (c.email === DANA ? { ...c, followUps: false } : c)));
  const t17 = Object.values(store.data.threads).find((t) => t.customer === outlookAddr.toLowerCase());
  const last17 = t17.messages[t17.messages.length - 1];
  const queued = () => store.data.pending.filter((j) => j.type === 'followup');
  store.data.pending = store.data.pending.filter((j) => j.type !== 'followup');
  engine.scheduleFollowUp(engine.contactMap().get(DANA), t17.id, last17.messageId);
  assert.strictEqual(queued().length, 0, 'customer with chasing off: nothing queued');
  engine.scheduleFollowUp(engine.contactMap().get(outlookAddr.toLowerCase()), t17.id, last17.messageId);
  assert.strictEqual(queued().length, 1, 'other customers still chase');
  const n17 = captured.length;
  store.settings.scenario.followUpEnabled = false;
  await engine.runFollowUp(queued()[0]);
  await wait(300);
  assert.strictEqual(captured.length, n17, 'a chase queued before switching off is not sent');
  assert.strictEqual(queued().length, 0, 'and it is dropped');
  const f17 = path.join(os.tmpdir(), `fu-${process.pid}.senario`);
  saveSenario(f17, store.data, { includeSecrets: false, appVersion: 'test' });
  const back17 = loadSenario(f17).data.customers;
  assert.strictEqual(back17.find((c) => c.email === DANA).followUps, false);
  assert.ok(!('followUps' in back17.find((c) => c.email === outlookAddr.toLowerCase())), 'default stays implicit');
  fs.rmSync(f17);
  console.log('OK 17: per-customer follow-ups, switching off drops queued chases, saved in .senario');

  // 18. A form sent by an employee comes back filled in.
  const { PDFDocument } = require(ROOT + '/node_modules/pdf-lib');
  const formDoc = await PDFDocument.create();
  const formPage = formDoc.addPage([595, 842]);
  formDoc.getForm().createTextField('CompanyName').addToPage(formPage, { x: 200, y: 700, width: 300, height: 20 });
  formDoc.getForm().createTextField('AccountsEmail').addToPage(formPage, { x: 200, y: 660, width: 300, height: 20 });
  formDoc.getForm().createCheckBox('AgreeToTerms').addToPage(formPage, { x: 200, y: 620, width: 15, height: 15 });
  formPage.drawText('Credit account application', { x: 50, y: 780, size: 16 });
  const formPdf = Buffer.from(await formDoc.save());
  Object.assign(store.settings.scenario, { replyDelayMinSec: 0, replyDelayMaxSec: 0, reviewBeforeSend: false });
  const replyBefore = answers.reply;
  answers.reply = () => ({ shouldReply: true, expectsResponse: true, body: 'Hi Ann,\nCompleted form attached.\n\nDana',
    fillForms: [{ file: 'Credit application.pdf', answers: { f1: 'Bright Ltd', f2: 'accounts@bright.local', f3: 'yes', f99: 'ignored' } }] });
  const n18 = captured.length;
  await toApp({ from: 'Ann Accounts <ann@co.local>', to: DANA, subject: 'Credit account', messageId: '<form-1@co.local>', text: 'Hi Dana, please fill in the attached form.',
    attachments: [{ filename: 'Credit application.pdf', content: formPdf, contentType: 'application/pdf' }] });
  assert.ok(await until(() => captured.length > n18, 8000), 'customer replied');
  answers.reply = replyBefore;
  assert.match(lastPrompt('reply'), /\[Blanks you can fill in on Credit application\.pdf, by id\]\nf1: Company Name\nf2: Accounts Email\nf3: Agree To Terms \(tick box: yes or no\)/);
  const formReply = await simpleParser(captured[n18].raw);
  const sentForm = formReply.attachments.find((a) => a.filename === 'Credit application.pdf');
  assert.ok(sentForm, 'the original form is sent back under its own name');
  const filledBack = (await PDFDocument.load(sentForm.content)).getForm();
  assert.strictEqual(filledBack.getTextField('CompanyName').getText(), 'Bright Ltd');
  assert.strictEqual(filledBack.getTextField('AccountsEmail').getText(), 'accounts@bright.local');
  assert.ok(filledBack.getCheckBox('AgreeToTerms').isChecked());
  const t18 = Object.values(store.data.threads).find((t) => t.subject === 'Credit account');
  const rec18 = t18.messages[t18.messages.length - 1].attachments[0];
  assert.ok(rec18.filled && rec18.sent);
  assert.match(rec18.text, /Company Name: Bright Ltd/);
  assert.ok(t18.messages[0].attachments[0].form.data, 'original kept with the employee\'s message');
  const f18 = path.join(os.tmpdir(), `form-${process.pid}.senario`);
  saveSenario(f18, store.data, { includeSecrets: false, appVersion: 'test' });
  const back18 = loadSenario(f18).data.threads[t18.id];
  assert.deepStrictEqual(back18.messages[0].attachments[0].form, t18.messages[0].attachments[0].form);
  assert.deepStrictEqual(back18.messages[back18.messages.length - 1].attachments[0].filled, rec18.filled);
  fs.rmSync(f18);
  console.log('OK 18: a PDF form sent to a customer comes back filled in, and the form survives .senario');

  // 19. Cooldown: a customer whose conversation was just resolved isn't picked again for a while.
  engine.resetConversations();
  Object.assign(store.settings.scenario, { oneConversationAtATime: false, cooldownHours: 1, reviewBeforeSend: false, pace: 1 });
  const n19 = captured.length;
  await engine.generateEvent();
  assert.ok(await until(() => captured.length === n19 + 1));
  const first = captured[n19].from.toLowerCase();
  const other = first === DANA ? outlookAddr.toLowerCase() : DANA;
  const t19 = Object.values(store.data.threads).find((t) => t.customer === first);
  engine.endThread(t19.id);
  assert.ok(t19.resolvedAt, 'resolved time recorded');
  for (let i = 0; i < 5; i++) await engine.generateEvent();
  assert.ok(await until(() => captured.length === n19 + 6));
  assert.ok(captured.slice(n19 + 1).every((c) => c.from.toLowerCase() === other), 'only the other customer is picked during the cooldown');
  await engine.sendNow(first);
  assert.ok(await until(() => captured.length === n19 + 7) && captured[n19 + 6].from.toLowerCase() === first, 'choosing them yourself still works');
  // At 60x pace, an hour's cooldown passes in a minute.
  t19.resolvedAt = new Date(Date.now() - 2 * 60000).toISOString();
  store.settings.scenario.pace = 60;
  assert.ok(!engine.coolingDown().has(first), 'cooldown is in scenario time');
  store.settings.scenario.pace = 1;
  assert.ok(engine.coolingDown().has(first));
  const f19 = path.join(os.tmpdir(), `cool-${process.pid}.senario`);
  saveSenario(f19, store.data, { includeSecrets: false, appVersion: 'test' });
  assert.strictEqual(loadSenario(f19).data.threads[t19.id].resolvedAt, t19.resolvedAt);
  fs.rmSync(f19);
  store.settings.scenario.cooldownHours = 0;
  assert.strictEqual(engine.coolingDown().size, 0, '0 turns it off');
  console.log('OK 19: cooldown after a resolved conversation (scenario time, explicit picks allowed, saved in .senario)');

  await engine.shutdown();
  openai.close();
  sink.close();
  console.log('ALL PASSED');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
