'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const mail = require('./mail');
const ai = require('./ai');
const { extractAttachments, fillForm } = require('./attachments');
const clock = require('./clock');
const { compose, mailHeaders, styleFor, rfc2822 } = require('./compose');
const documents = require('./documents');
const calendar = require('./calendar');

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;
const randBetween = (a, b) => a + Math.random() * Math.max(0, b - a);
const lc = (s) => String(s || '').trim().toLowerCase();
const domainOf = (email) => lc(email).split('@')[1] || '';

function addrList(field) {
  if (!field) return [];
  const groups = Array.isArray(field) ? field : [field];
  return groups.flatMap((g) => g.value || []).map((a) => ({ email: lc(a.address), name: a.name || '' }));
}

// Keep only the new text of an email, dropping quoted history.
function stripQuoted(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (
      /^On .+wrote:\s*$/.test(line) ||
      /^-{2,}\s*Original Message\s*-{2,}/i.test(line) ||
      /^_{10,}\s*$/.test(line) ||
      (/^From: .+/.test(line) && out.length > 2)
    ) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

// Human-friendly duration, e.g. "under a minute", "~25 min", "~3 hours", "~2 days".
function fmtWait(ms) {
  const min = ms / 60000;
  if (min < 1) return 'under a minute';
  if (min < 90) return `~${Math.round(min)} min`;
  const h = min / 60;
  if (h < 36) return `~${Math.round(h)} hours`;
  return `~${Math.round(h / 24)} days`;
}

const baseSubject = (s) => String(s || '').replace(/^\s*((re|fw|fwd|aw|accepted|declined|tentative)\s*:\s*)+/i, '').trim();

class Engine extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.running = false;
    this.timers = { event: null, background: null, injects: null };
    this.nextEventAt = null;
    this.nextBackgroundAt = null;
    this.replyTimers = new Map();
    this.listener = null;
    this.listenerError = null;
  }

  // ---------- helpers ----------

  log(level, message) {
    this.emit('log', { time: new Date().toISOString(), level, message });
  }

  get settings() {
    return this.store.settings;
  }

  get company() {
    return this.store.company;
  }

  get data() {
    return this.store.data;
  }

  employees() {
    return (this.company.employees || []).filter((e) => e.email && e.email.includes('@'));
  }

  employeeMap() {
    return new Map(this.employees().map((e) => [lc(e.email), e]));
  }

  customerMap() {
    return new Map((this.store.customers || []).map((c) => [lc(c.email), c]));
  }

  // Everyone the app plays: customers (who start conversations) and external
  // parties such as suppliers and contractors (who only ever respond).
  contactMap() {
    const map = new Map();
    for (const p of this.store.parties || []) if (p.email) map.set(lc(p.email), { ...p, kind: 'party' });
    for (const c of this.store.customers || []) if (c.email) map.set(lc(c.email), { ...c, kind: 'customer' });
    return map;
  }

  // Records when a conversation was resolved, for the cooldown below.
  setStatus(thread, status) {
    if (status === 'resolved' && thread.status !== 'resolved') thread.resolvedAt = new Date().toISOString();
    thread.status = status;
  }

  // Customers whose last conversation was resolved too recently to start another
  // (Settings → Scenario behaviour; scenario time, so the pace speeds it up).
  coolingDown() {
    const wait = (Number(this.settings.scenario.cooldownHours) || 0) * 3600000 / this.pace;
    const out = new Set();
    if (wait <= 0) return out;
    for (const t of Object.values(this.data.threads)) {
      if (!t.background && t.customer && t.status === 'resolved' && t.resolvedAt && Date.now() - Date.parse(t.resolvedAt) < wait) out.add(lc(t.customer));
    }
    return out;
  }

  // Customers with an open conversation, or a new email waiting in the Outbox.
  busyCustomers() {
    const busy = new Set();
    for (const t of Object.values(this.data.threads)) {
      if (!t.background && t.status !== 'resolved' && t.customer) busy.add(lc(t.customer));
    }
    for (const d of this.data.outbox || []) if (!d.threadId && d.sender) busy.add(lc(d.sender));
    return busy;
  }

  // Other people at the same organisation (same email domain).
  colleaguesOf(contact) {
    const d = domainOf(contact.email);
    return [...this.contactMap().values()].filter((c) => domainOf(c.email) === d && lc(c.email) !== lc(contact.email));
  }

  companyDomains() {
    const set = new Set([lc(this.company.domain)]);
    for (const e of this.employees()) set.add(domainOf(e.email));
    set.delete('');
    return set;
  }

  // Domains the listener accepts mail for: every customer and external party.
  contactDomains() {
    const set = new Set([...this.contactMap().keys()].map(domainOf));
    set.delete('');
    return [...set];
  }

  // The company's operating year (e.g. 2005), or null for the present day.
  get year() {
    return clock.validYear(this.company.operatingYear);
  }

  scenarioNow() {
    return clock.toScenario(new Date(), this.year);
  }

  nowText() {
    return clock.formatScenario(new Date(), this.year);
  }

  aiCompany() {
    return { ...this.company, employees: this.employees() };
  }

  // Add a dated note to a customer's or party's memory of the company.
  remember(email, note) {
    const text = String(note || '').trim();
    if (!text) return;
    const list = [...(this.store.customers || []), ...(this.store.parties || [])];
    const c = list.find((x) => lc(x.email) === lc(email));
    if (!c) return;
    const when = this.scenarioNow().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    c.memory = [...(c.memory || []), `${when}: ${text.slice(0, 200)}`].slice(-10);
    this.store.save();
  }

  status() {
    const l = this.settings.listener;
    return {
      running: this.running,
      nextEventAt: this.nextEventAt,
      nextBackgroundAt: this.nextBackgroundAt,
      pendingReplies: (this.data.pending || []).length,
      outbox: (this.data.outbox || []).length,
      threads: Object.keys(this.data.threads).length,
      listening: this.listener ? `${l.bindAddress}:${l.port}` : null,
      listenerError: this.listenerError || null,
      allowedSources: this.listener ? this.listener.allowed : [],
      pace: this.pace,
      operatingYear: this.year,
      clockOffsetMs: clock.offsetMs(this.year),
      exerciseMs: this.exerciseElapsed(),
      exerciseRunning: !!this.data.exercise.runningSince,
      injectsPending: (this.data.injects || []).filter((i) => i.status === 'pending').length,
    };
  }

  emitStatus() {
    this.emit('status', this.status());
  }

  // ---------- lifecycle ----------

  validate() {
    mail.serverHost(this.settings.mail);
    if (!this.settings.openai.apiKey) throw new Error('OpenAI API key is not set.');
    if (!this.company.name || !this.company.description) throw new Error('Enter the company name and description first.');
    if (!this.employees().length) throw new Error('Add at least one employee first.');
    if (!this.contactMap().size) throw new Error('Add customers or external parties first.');
    const clash = this.contactDomains().filter((d) => this.companyDomains().has(d));
    if (clash.length) throw new Error(`Customer/party domain(s) overlap the company domain: ${clash.join(', ')}`);
  }

  // The reply listener runs for as long as the app is open, whether or not the
  // scenario is started, so the mail server can always deliver replies.
  async openListener() {
    if (this.listener) return;
    try {
      this.listener = await mail.startListener({
        mail: this.settings.mail,
        listener: this.settings.listener,
        acceptRecipient: (addr) => this.contactDomains().includes(domainOf(addr)),
        onMessage: (parsed, envelope) => this.handleIncoming(parsed, envelope),
        log: (level, msg) => this.log(level, msg),
      });
      this.listenerError = null;
      const l = this.settings.listener;
      this.log('info', `Listening for replies on ${l.bindAddress}:${l.port}, accepting only from ${this.listener.allowed.join(', ')}`);
    } catch (e) {
      this.listenerError = e.message;
      this.log('error', 'Reply listener not running: ' + e.message);
      throw e;
    } finally {
      this.emitStatus();
    }
  }

  async closeListener() {
    if (!this.listener) return;
    const { server } = this.listener;
    this.listener = null;
    await new Promise((r) => server.close(r));
    this.emitStatus();
  }

  async restartListener() {
    await this.closeListener();
    await this.openListener();
  }

  async start() {
    if (this.running) return;
    this.validate();
    await this.openListener();
    this.running = true;
    const ex = this.data.exercise;
    ex.runningSince = Date.now();
    if (!ex.startedAt) ex.startedAt = new Date().toISOString();
    this.store.save();
    this.log('info', `Scenario started. Sending via ${mail.serverHost(this.settings.mail)}:${this.settings.mail.smtpPort}`);
    this.scheduleNextEvent();
    this.scheduleBackground();
    this.timers.injects = setInterval(() => this.checkInjects(), 2000);
    this.resumePendingReplies();
    this.checkInjects();
    this.emitStatus();
  }

  async stop() {
    if (!this.running) return;
    this.foldExercise();
    this.running = false;
    this.data.exercise.runningSince = null;
    clearTimeout(this.timers.event);
    clearTimeout(this.timers.background);
    clearInterval(this.timers.injects);
    for (const t of this.replyTimers.values()) clearTimeout(t);
    this.replyTimers.clear();
    this.nextEventAt = null;
    this.nextBackgroundAt = null;
    this.store.save();
    this.log('info', 'Scenario stopped. The listener stays up; replies received now are answered on next start.');
    this.emitStatus();
  }

  async shutdown() {
    await this.stop();
    await this.closeListener();
  }

  // 1 = real business time; higher values compress every delay by that factor.
  get pace() {
    return Math.max(1, Number(this.settings.scenario.pace) || 1);
  }

  // Working-hours limits only make sense at real-time pace.
  inWorkingHours(d = new Date()) {
    const s = this.settings.scenario;
    if (!s.workingHoursOnly || this.pace > 1) return true;
    const day = d.getDay();
    const h = d.getHours();
    return day >= 1 && day <= 5 && h >= s.workStartHour && h < s.workEndHour;
  }

  // Start of the next working period (plus up to 90 minutes, as people ease in).
  nextWorkingTime() {
    const s = this.settings.scenario;
    const d = new Date();
    d.setMinutes(0, 0, 0);
    for (let i = 0; i < 24 * 8; i++) {
      d.setHours(d.getHours() + 1);
      if (d.getHours() === Number(s.workStartHour) && this.inWorkingHours(d)) break;
    }
    return d.getTime() + Math.random() * 90 * 60000;
  }

  // ---------- exercise clock ----------
  // Scenario time elapsed since the exercise started: counts only while running and
  // runs faster at higher pace. Injects are scheduled against it, and every message
  // records it so the report can measure response times in scenario time.

  exerciseElapsed() {
    const ex = this.data.exercise;
    return ex.elapsedMs + (ex.runningSince ? (Date.now() - ex.runningSince) * this.pace : 0);
  }

  foldExercise() {
    const ex = this.data.exercise;
    ex.elapsedMs = this.exerciseElapsed();
    ex.runningSince = this.running ? Date.now() : null;
  }

  resetExercise() {
    this.data.exercise = { elapsedMs: 0, runningSince: this.running ? Date.now() : null, startedAt: this.running ? new Date().toISOString() : null };
    for (const i of this.data.injects || []) {
      i.status = 'pending';
      delete i.firedAt;
      delete i.firedAtMs;
      delete i.error;
    }
    this.store.save();
    this.log('info', 'Exercise clock reset to T+0:00. All injects are pending again.');
    this.emit('injects-changed');
    this.emitStatus();
  }

  // ---------- timers: new customer emails and background mail ----------

  scheduleNextEvent() {
    if (!this.running) return;
    const s = this.settings.scenario;
    const mins = randBetween(Number(s.minIntervalMin) || 1, Number(s.maxIntervalMin) || 1);
    this.armTimer('event', (mins * 60000) / this.pace);
  }

  scheduleBackground() {
    const s = this.settings.scenario;
    if (!this.running || !s.backgroundEnabled) {
      clearTimeout(this.timers.background);
      this.nextBackgroundAt = null;
      return;
    }
    const mins = randBetween(Number(s.backgroundMinMin) || 30, Number(s.backgroundMaxMin) || 120);
    this.armTimer('background', (mins * 60000) / this.pace);
  }

  armTimer(name, ms) {
    clearTimeout(this.timers[name]);
    ms = Math.max(5000, ms);
    const at = new Date(Date.now() + ms).toISOString();
    if (name === 'event') this.nextEventAt = at;
    else this.nextBackgroundAt = at;
    this.timers[name] = setTimeout(async () => {
      if (name === 'event') {
        if (this.inWorkingHours()) await this.generateEvent().catch((e) => this.log('error', 'Generate failed: ' + e.message));
        this.scheduleNextEvent();
      } else {
        await this.generateBackground().catch((e) => this.log('error', 'Background mail failed: ' + e.message));
        this.scheduleBackground();
      }
    }, ms);
    this.emitStatus();
  }

  // Change pace live: everything already scheduled is rescaled to the new speed.
  setPace(newPace) {
    const oldPace = this.pace;
    this.foldExercise();
    this.settings.scenario.pace = Math.max(1, Number(newPace) || 1);
    this.store.save();
    const ratio = oldPace / this.pace;
    if (ratio === 1) return this.status();
    const now = Date.now();
    for (const job of this.data.pending || []) {
      job.due = now + Math.max(0, job.due - now) * ratio;
      if (this.replyTimers.has(job.id)) {
        clearTimeout(this.replyTimers.get(job.id));
        this.armJob(job);
      }
    }
    this.store.save();
    if (this.running && this.nextEventAt) this.armTimer('event', Math.max(0, Date.parse(this.nextEventAt) - now) * ratio);
    if (this.running && this.nextBackgroundAt) this.armTimer('background', Math.max(0, Date.parse(this.nextBackgroundAt) - now) * ratio);
    this.log('info', this.pace === 1 ? 'Pace set to real business time.' : `Pace set to ${this.pace}× faster than real time.`);
    this.emitStatus();
    return this.status();
  }

  // Settings that change timers take effect immediately while running.
  settingsChanged() {
    if (this.running && this.settings.scenario.backgroundEnabled && !this.nextBackgroundAt) this.scheduleBackground();
    if (this.running && !this.settings.scenario.backgroundEnabled) this.scheduleBackground();
  }

  // ---------- DKIM ----------

  // Signing keys are generated per sender domain on first use and kept in the scenario.
  dkimKey(domain) {
    const keys = this.data.dkimKeys;
    if (!keys[domain]) {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      keys[domain] = {
        selector: 'senario',
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      };
      this.store.save();
    }
    return keys[domain];
  }

  dkimFor(email) {
    if (!this.settings.mail.dkim) return undefined;
    const domain = domainOf(email);
    const k = this.dkimKey(domain);
    return { domainName: domain, keySelector: k.selector, privateKey: k.privateKey };
  }

  // DNS TXT records to publish on the scenario's DNS server, one per contact domain.
  dkimRecords() {
    return this.contactDomains().sort().map((d) => {
      const k = this.dkimKey(d);
      return { domain: d, name: `${k.selector}._domainkey.${d}`, value: `v=DKIM1; k=rsa; p=${k.publicKey}` };
    });
  }

  // ---------- sending ----------

  // Recipients must be on a company domain, or be another known customer/party (a
  // colleague copied in). Every address on the list routes back to the scenario's own
  // mail server, so traffic stays contained, and each message must reach the company.
  checkRecipients(to, cc) {
    const company = this.companyDomains();
    const contacts = this.contactMap();
    const all = [...to, ...cc].map(lc);
    const blocked = all.filter((e) => !company.has(domainOf(e)) && !contacts.has(e));
    if (blocked.length) throw new Error(`Refusing to send to address(es) outside the scenario: ${blocked.join(', ')}`);
    if (!all.some((e) => company.has(domainOf(e)))) throw new Error('Every email must be addressed to someone at the company.');
  }

  // Sends one message. body is the new text only; quoted is the thread message being
  // replied to (if any). extra: { attachments, icalEvent, headers, layout, meta, ... }.
  async deliver({ customer, to, cc = [], subject, body, quoted = null, threadId, inReplyTo, references = [], extra = {} }) {
    this.checkRecipients(to, cc);
    const thread0 = threadId && this.data.threads[threadId];
    const date = new Date();
    const people = new Map([...this.employeeMap()].map(([e, p]) => [e, p.name]));
    for (const [e, c] of this.contactMap()) people.set(e, c.name);
    const fmt = (e) => (people.get(lc(e)) ? { name: people.get(lc(e)), address: e } : e);
    const content = compose({
      body,
      sender: customer,
      quoted,
      format: this.settings.scenario.emailFormat === 'text' ? 'text' : 'html',
      year: this.year,
      nameOf: (e) => people.get(lc(e)) || '',
      layout: extra.layout,
    });
    const hdr = mailHeaders({
      sender: customer,
      year: this.year,
      date: clock.toScenario(date, this.year),
      subject,
      threadIndex: thread0 && thread0.threadIndex,
      bulk: extra.background ? (extra.layout === 'newsletter' ? 'newsletter' : 'notification') : null,
    });
    const messageId = hdr.messageId;
    this.data.sentIds[messageId] = Date.now();
    const sentDate = this.year && this.company.datedEmails !== false ? clock.toScenario(date, this.year) : date;
    await mail.sendMail(this.settings.mail, {
      messageId,
      envelope: { from: extra.envelopeFrom || customer.email, to: [...to, ...cc] },
      from: { name: customer.name, address: customer.email },
      to: to.map(fmt),
      cc: cc.map(fmt),
      subject,
      text: content.text,
      html: content.html,
      headers: { Date: rfc2822(sentDate), ...hdr.headers, ...(extra.headers || {}) },
      attachments: (extra.attachments || []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
      icalEvent: extra.icalEvent,
      dkim: this.dkimFor(customer.email),
      inReplyTo: inReplyTo || undefined,
      references: references.length ? references.join(' ') : undefined,
    });

    const record = {
      messageId,
      from: lc(customer.email),
      fromName: customer.name,
      to,
      cc,
      subject,
      body: String(body || '').trim(),
      date: date.toISOString(),
      exerciseMs: this.exerciseElapsed(),
      direction: 'out',
      ...(extra.attachments && extra.attachments.length ? { attachments: extra.attachments.map((a) => a.record) } : {}),
      ...(extra.meta || {}),
    };
    const thread = this.addToThread(threadId, record, subject, extra.threadOwner || customer.email);
    if (!thread.threadIndex && hdr.threadIndex) thread.threadIndex = hdr.threadIndex;
    if (extra.background) thread.background = true;
    const who = customer.kind === 'party'
      ? `${customer.name} (${customer.organisation}, ${customer.role || 'external party'})`
      : customer.organisation ? `${customer.name} (${customer.organisation})` : customer.name;
    const files = extra.attachments && extra.attachments.length ? ` with ${extra.attachments.map((a) => a.filename).join(', ')}` : '';
    this.log('send', `${who} → ${[...to, ...cc].join(', ')}: "${subject}"${files}${extra.icalEvent ? ' + meeting invitation' : ''}`);
    this.emit('threads-changed');
    this.emitStatus();
    return { thread, record };
  }

  addToThread(threadId, record, subject, customerEmail) {
    const data = this.data;
    let thread = threadId && data.threads[threadId];
    if (!thread) {
      threadId = threadId || crypto.randomUUID();
      thread = { id: threadId, subject: baseSubject(subject), customer: lc(customerEmail), messages: [], updatedAt: record.date, status: 'open' };
      data.threads[threadId] = thread;
    }
    if (!thread.messages.some((m) => m.messageId === record.messageId)) thread.messages.push(record);
    thread.updatedAt = record.date;
    data.msgIndex[record.messageId] = thread.id;
    this.store.save();
    return thread;
  }

  // Fallback threading for clients/servers that drop In-Reply-To and References:
  // the most recent thread with the same base subject and one of the same customers.
  findThreadBySubject(subject, addresses) {
    const base = baseSubject(subject).toLowerCase();
    if (!base) return undefined;
    const addrs = new Set(addresses.map(lc));
    const match = Object.values(this.data.threads)
      .filter((t) => !t.background && t.subject.toLowerCase() === base && addrs.has(t.customer))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    return match && match.id;
  }

  historyFor(customerEmail) {
    return Object.values(this.data.threads)
      .filter((t) => t.customer === lc(customerEmail))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, 10)
      .map((t) => t.subject);
  }

  // ---------- drafts: every outgoing email goes through here ----------
  //
  // A draft is plain data, so it can wait in the Outbox for review and survive restarts:
  // { kind, sender | senderInline, to, cc, subject, body, threadId, quotedId, inReplyTo,
  //   references, followUp, followUpAttempt, resolves, remember, document, meeting,
  //   headers, layout, envelopeFrom, skipReview }

  async submit(draft) {
    draft.id = draft.id || crypto.randomUUID();
    draft.createdAt = draft.createdAt || new Date().toISOString();
    if (this.settings.scenario.reviewBeforeSend && !draft.skipReview) {
      this.data.outbox.push(draft);
      this.store.save();
      const s = this.senderOf(draft);
      this.log('info', `${s ? s.name : 'Email'} drafted "${draft.subject}": waiting for review in the Outbox`);
      this.emit('outbox-changed');
      this.emitStatus();
      return { queued: true, draft };
    }
    return this.sendDraft(draft);
  }

  senderOf(draft) {
    return draft.senderInline || this.contactMap().get(lc(draft.sender)) || null;
  }

  async sendDraft(draft) {
    const customer = this.senderOf(draft);
    if (!customer) throw new Error(`Unknown sender ${draft.sender}`);
    const thread0 = draft.threadId && this.data.threads[draft.threadId];
    const quoted = thread0 && draft.quotedId ? thread0.messages.find((m) => m.messageId === draft.quotedId) : null;
    const extra = {
      meta: { kind: draft.kind, ...(draft.followUpAttempt ? { followUp: draft.followUpAttempt } : {}) },
      headers: draft.headers,
      layout: draft.layout,
      background: draft.kind === 'background',
      envelopeFrom: draft.envelopeFrom,
    };
    const org = { name: customer.organisation || customer.name, email: customer.email, person: customer.name, year: this.year, now: this.scenarioNow() };
    if (draft.document) {
      extra.attachments = [await documents.generate(draft.document, org)];
    }
    for (const f of draft.forms || []) {
      const file = await this.filledForm(f, thread0, org).catch((e) => this.log('error', `Could not fill in the form: ${e.message}`));
      if (file) (extra.attachments = extra.attachments || []).push(file);
    }
    if (draft.meeting) {
      const m = calendar.normaliseMeeting(draft.meeting, this.scenarioNow());
      if (m) {
        const people = this.employeeMap();
        const { client } = styleFor(customer.email, this.year);
        const inv = calendar.invite({
          meeting: m,
          organizer: { name: customer.name, email: customer.email },
          attendees: [...draft.to, ...(draft.cc || [])].map((e) => ({ email: e, name: (people.get(lc(e)) || {}).name })),
          prodId: client.prodId ? `-//Microsoft Corporation//${client.prodId}//EN` : undefined,
          stamp: this.scenarioNow(),
        });
        extra.icalEvent = { method: 'REQUEST', filename: 'invite.ics', content: inv.ics };
        extra.meta.meeting = calendar.describe(m);
      }
    }
    const { thread, record } = await this.deliver({
      customer,
      to: draft.to,
      cc: draft.cc || [],
      subject: draft.subject,
      body: draft.body,
      quoted,
      threadId: draft.threadId,
      inReplyTo: draft.inReplyTo,
      references: draft.references || [],
      extra,
    });
    if (draft.remember) this.remember(customer.email, draft.remember);
    if (draft.kind !== 'background' && draft.kind !== 'ooo') this.setStatus(thread, draft.resolves ? 'resolved' : 'open');
    if (draft.followUp) this.scheduleFollowUp(customer, thread.id, record.messageId, (draft.followUpAttempt || 0) + 1);
    this.store.save();
    return { thread, record };
  }

  // A form the company sent, filled in with the customer's answers. If the file can't be
  // filled, a completed copy is sent as a new document in the same format instead.
  async filledForm({ messageId, idx, answers }, thread, org) {
    const msg = thread && thread.messages.find((m) => m.messageId === messageId);
    const src = msg && msg.attachments && msg.attachments[idx];
    if (!src || !src.form) throw new Error('the original form is no longer available');
    const labels = new Map(src.form.fields.map((f) => [f.id, f.label]));
    const text = Object.entries(answers).map(([id, v]) => `${labels.get(id) || id}: ${v}`).join('\n');
    try {
      const content = await fillForm(src, answers);
      return { filename: src.filename, content, contentType: src.contentType || 'application/octet-stream',
        record: { filename: src.filename, contentType: src.contentType, size: content.length, kind: src.kind, status: 'ok', text, truncated: false,
          sent: true, filled: { messageId, idx, answers } } };
    } catch (e) {
      this.log('error', `Could not fill in ${src.filename} (${e.message}); sending a completed copy instead.`);
      const format = src.kind === 'docx' ? 'word' : src.kind === 'spreadsheet' ? 'excel' : 'pdf';
      return documents.generate({ format, title: src.filename.replace(/\.[^.]+$/, '') + ' (completed)',
        fields: Object.fromEntries(Object.entries(answers).map(([id, v]) => [labels.get(id) || id, v])) }, org);
    }
  }

  // Outbox (review queue): send with optional edits, or discard.
  async approveDraft(id, edits = {}) {
    const i = this.data.outbox.findIndex((d) => d.id === id);
    if (i < 0) throw new Error('That draft is no longer in the Outbox.');
    const draft = { ...this.data.outbox[i] };
    for (const k of ['subject', 'body']) if (typeof edits[k] === 'string') draft[k] = edits[k];
    for (const k of ['to', 'cc']) if (Array.isArray(edits[k])) draft[k] = edits[k].map(lc).filter(Boolean);
    if (edits.dropDocument) delete draft.document;
    if (edits.dropForms) delete draft.forms;
    if (edits.dropMeeting) delete draft.meeting;
    this.checkRecipients(draft.to, draft.cc || []);
    try {
      await this.sendDraft(draft);
    } catch (e) {
      this.data.outbox[i].error = e.message;
      this.store.save();
      this.emit('outbox-changed');
      throw e;
    }
    this.data.outbox = this.data.outbox.filter((d) => d.id !== id);
    this.store.save();
    this.emit('outbox-changed');
    this.emitStatus();
  }

  discardDraft(id) {
    const d = this.data.outbox.find((x) => x.id === id);
    this.data.outbox = this.data.outbox.filter((x) => x.id !== id);
    this.store.save();
    if (d) this.log('info', `Discarded draft "${d.subject}"`);
    this.emit('outbox-changed');
    this.emitStatus();
  }

  // Write and send an email yourself, as any customer or party. Never held for review.
  async composeManual({ from, to = [], cc = [], subject, body, threadId, expectReply = true }) {
    const sender = this.contactMap().get(lc(from));
    if (!sender) throw new Error('Choose a customer or party to send as.');
    if (!String(body || '').trim()) throw new Error('Write a message first.');
    const draft = { kind: 'manual', sender: sender.email, to: to.map(lc), cc: cc.map(lc), subject, body, followUp: expectReply, skipReview: true };
    const t = threadId && this.data.threads[threadId];
    if (t) {
      const last = t.messages[t.messages.length - 1];
      Object.assign(draft, {
        threadId: t.id,
        quotedId: last.messageId,
        inReplyTo: last.messageId,
        references: t.messages.map((m) => m.messageId).slice(-10),
        subject: subject || `Re: ${t.subject}`,
      });
    }
    if (!draft.subject) throw new Error('Enter a subject.');
    return this.sendDraft(draft);
  }

  // ---------- new customer emails ----------

  // One unsolicited email from a random customer. External parties never start
  // conversations, so they are never picked here. brief/to come from scripted injects.
  async generateEvent(customerEmail, { brief, to: injectTo, skipReview } = {}) {
    const customers = this.store.customers || [];
    const staff = this.employeeMap();
    // Parties never start conversations on their own; they only write when chosen
    // explicitly (Send an email now, or an inject).
    if (!customers.length && !customerEmail) {
      return this.log('info', 'No customers defined, so no new emails are started (external parties only reply).');
    }
    if (!staff.size) throw new Error('No employees defined.');
    const contact = customerEmail && this.contactMap().get(lc(customerEmail));
    if (customerEmail && !contact) throw new Error(`Unknown customer or party ${customerEmail}.`);
    const s = this.settings.scenario;

    // A random pick skips customers who are still in a conversation (when that's on) or
    // cooling down after one. Choosing someone explicitly (Send an email now, an inject)
    // always goes ahead.
    let candidates = customers;
    if (!contact) {
      const busy = s.oneConversationAtATime !== false ? this.busyCustomers() : new Set();
      const cooling = this.coolingDown();
      candidates = customers.filter((c) => !busy.has(lc(c.email)) && !cooling.has(lc(c.email)));
      if (!candidates.length) {
        return this.log('info', cooling.size
          ? 'Every customer is still in a conversation or cooling down after one, so no new email was started.'
          : 'Every customer is still in a conversation, so no new email was started.');
      }
    }

    const customer = contact || { ...pick(candidates), kind: 'customer' };
    const colleagues = this.colleaguesOf(customer);
    this.log('info', `Composing email from ${customer.name} (${customer.organisation || customer.role})…`);
    const d = await ai.writeCustomerEmail(this.settings.openai, {
      company: this.aiCompany(),
      customer,
      colleagues,
      history: this.historyFor(customer.email),
      guidance: s.guidance,
      now: this.nowText(),
      allowDocuments: s.allowDocuments !== false,
      allowMeetings: s.allowMeetings !== false,
      brief,
      to: injectTo,
    });
    if (!d.subject || !d.body) throw new Error('Model returned an empty email.');

    // Only real employees may be addressed; fall back to a random one if the model strays.
    let to = injectTo && injectTo.length ? injectTo.map(lc).filter((e) => staff.has(e)) : [lc(d.to)].filter((e) => staff.has(e));
    if (!to.length) to = [lc(pick(this.employees()).email)];
    const colleagueSet = new Set(colleagues.map((c) => lc(c.email)));
    const cc = [
      ...[].concat(d.cc || []).map(lc).filter((e) => staff.has(e) && !to.includes(e)).slice(0, 2),
      ...[].concat(d.ccColleagues || []).map(lc).filter((e) => colleagueSet.has(e)).slice(0, 2),
    ];
    return this.submit({
      kind: brief ? 'inject' : 'new',
      sender: customer.email,
      to,
      cc,
      subject: d.subject,
      body: d.body,
      followUp: true,
      remember: d.remember,
      document: s.allowDocuments !== false ? d.document : null,
      meeting: s.allowMeetings !== false ? d.meeting : null,
      skipReview,
    });
  }

  // ---------- background mail ----------

  async generateBackground() {
    const staff = this.employeeMap();
    if (!staff.size) return null;
    const s = this.settings.scenario;
    const tld = String(s.customerTld || 'local').replace(/^\./, '');
    const recent = Object.values(this.data.threads).filter((t) => t.background)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 8).map((t) => t.customer);
    const d = await ai.writeBackgroundEmail(this.settings.openai, {
      company: this.aiCompany(), now: this.nowText(), tld, recentSenders: recent, guidance: s.guidance,
    });
    if (!d.subject || !d.body) throw new Error('Model returned an empty email.');
    // The sender must be fictional and outside the company; otherwise use a safe address.
    let from = lc(d.fromEmail);
    const bad = !/^[^@\s]+@[a-z0-9.-]+$/.test(from) || !from.endsWith(`.${tld}`) || this.companyDomains().has(domainOf(from));
    if (bad) {
      const slug = String(d.organisation || d.fromName || 'updates').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'updates';
      from = `${d.category === 'newsletter' ? 'news' : 'noreply'}@${slug}.${tld}`;
    }
    let to = [].concat(d.to || []).map(lc).filter((e) => staff.has(e)).slice(0, 4);
    if (!to.length) to = [lc(pick(this.employees()).email)];
    const newsletter = d.category === 'newsletter';
    const dom = domainOf(from);
    return this.submit({
      kind: 'background',
      senderInline: { name: d.fromName || d.organisation || dom, email: from, organisation: d.organisation || d.fromName, kind: 'background' },
      to,
      cc: [],
      subject: d.subject,
      body: d.body,
      layout: newsletter ? 'newsletter' : 'notification',
      envelopeFrom: newsletter ? `bounce-${crypto.randomBytes(4).toString('hex')}@${dom}` : undefined,
      headers: newsletter
        ? { Precedence: 'bulk', 'List-Id': `${d.organisation || dom} <news.${dom}>`, 'List-Unsubscribe': `<mailto:unsubscribe@${dom}>` }
        : { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
      followUp: false,
      skipReview: true,
    });
  }

  // ---------- incoming (company → customer) ----------

  async handleIncoming(parsed, envelope) {
    const data = this.data;
    const messageId = parsed.messageId || `<generated-${crypto.randomUUID()}@local>`;
    if (data.sentIds[messageId] || data.processedIds[messageId]) return;
    data.processedIds[messageId] = Date.now();
    this.store.save();

    const from = addrList(parsed.from)[0] || { email: lc(envelope.from), name: '' };
    const subject = parsed.subject || '(no subject)';
    const customers = this.contactMap();

    // Bounces, out-of-office and other automated mail: log, never answer.
    const auto = lc(parsed.headers.get('auto-submitted'));
    const precedence = lc(parsed.headers.get('precedence'));
    if (!envelope.from || /^(mailer-daemon|postmaster)@/.test(from.email)) {
      this.log('error', `Bounce/notification received: "${subject}"`);
      return;
    }
    if ((auto && auto !== 'no') || ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) {
      this.log('info', `Ignored automatic reply from ${from.email}: "${subject}"`);
      return;
    }
    if (customers.has(from.email)) return; // a customer's own mail looping back

    const to = addrList(parsed.to).map((a) => a.email);
    const cc = addrList(parsed.cc).map((a) => a.email);
    const rcpt = (envelope.to || []).map(lc);

    // Thread lookup via In-Reply-To / References.
    const refs = []
      .concat(parsed.inReplyTo || [])
      .concat(parsed.references || [])
      .flatMap((r) => String(r).split(/\s+/))
      .filter(Boolean);
    let threadId = refs.map((r) => data.msgIndex[r]).find(Boolean);
    if (!threadId) threadId = this.findThreadBySubject(subject, [from.email, ...to, ...cc, ...rcpt]);

    // The customer who answers: first addressed in To, then Cc, then the envelope.
    const customer =
      [...to, ...cc, ...rcpt].map((e) => customers.get(e)).find(Boolean) ||
      (threadId ? customers.get(data.threads[threadId].customer) : null);

    // A response to a meeting invitation (Accept / Tentative / Decline)?
    const calPart = (parsed.attachments || []).find((a) => /text\/calendar/i.test(a.contentType || '') || /\.ics$/i.test(a.filename || ''));
    const cal = calPart ? calendar.parse(calPart.content.toString('utf8')) : null;
    const meetingResponse = cal && cal.method === 'REPLY'
      ? `${{ ACCEPTED: 'Accepted', TENTATIVE: 'Tentatively accepted', DECLINED: 'Declined' }[cal.partstat] || 'Responded to'} the meeting "${cal.summary || baseSubject(subject)}"`
      : null;

    // Read attachments (quotes, invoices, spreadsheets...) so the customer can respond to them.
    const attachments = await extractAttachments((parsed.attachments || []).filter((a) => a !== calPart), {
      describeImage: this.settings.openai.apiKey
        ? (buf, mime, name) => ai.describeImage(this.settings.openai, buf, mime, name)
        : null,
    });
    for (const a of attachments.filter((x) => x.status === 'error')) {
      this.log('error', `Could not read attachment ${a.filename}: ${a.error}`);
    }

    const record = {
      messageId,
      from: from.email,
      fromName: from.name,
      to,
      cc,
      subject,
      body: stripQuoted(parsed.text || ''),
      // Receipt time on the real clock, so ordering and delays stay consistent even
      // when lab machines' clocks are set to the scenario year.
      date: new Date().toISOString(),
      exerciseMs: this.exerciseElapsed(),
      direction: 'in',
      attachments,
      ...(meetingResponse ? { meetingResponse } : {}),
    };
    const thread = this.addToThread(threadId, record, subject, customer ? customer.email : rcpt[0]);
    thread.status = 'open';
    this.cancelFollowUps(thread.id);
    const files = attachments.length ? ` with ${attachments.map((a) => a.filename + (a.status === 'ok' ? '' : ` (${a.status})`)).join(', ')}` : '';
    this.log('recv', `${from.name || from.email} → ${[...to, ...cc].join(', ') || rcpt.join(', ')}: "${subject}"${files}`);
    this.emit('threads-changed');

    if (!customer) {
      this.log('info', `No customer persona for ${rcpt.join(', ')}; not replying.`);
      return;
    }
    if (!this.companyDomains().has(domainOf(from.email))) {
      this.log('info', `Sender ${from.email} is outside the company domain; not replying.`);
      return;
    }
    // Accepting or tentatively accepting an invitation needs no answer.
    if (meetingResponse && cal.partstat !== 'DECLINED') {
      this.log('info', `${from.name || from.email}: ${meetingResponse}`);
      this.setStatus(thread, 'resolved');
      this.store.save();
      return;
    }
    // Sometimes the customer is away: an automatic out-of-office first, real reply later.
    const s = this.settings.scenario;
    if (!thread.messages.some((m) => m.kind === 'ooo' && m.from === lc(customer.email)) && chance(Number(s.oooChance) || 0)) {
      const days = 1 + Math.floor(Math.random() * 3);
      await this.sendOutOfOffice(customer, thread, record, days).catch((e) => this.log('error', 'Out-of-office failed: ' + e.message));
      this.queueReply(customer, thread.id, messageId, days * 86400000);
      return;
    }
    this.queueReply(customer, thread.id, messageId);
  }

  // Automatic reply in the style of the customer's mail program.
  async sendOutOfOffice(customer, thread, incoming, days) {
    const back = new Date(this.scenarioNow().getTime() + days * 86400000);
    while (back.getDay() === 0 || back.getDay() === 6) back.setDate(back.getDate() + 1);
    const backText = back.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    const colleague = this.colleaguesOf(customer)[0];
    const { client } = styleFor(customer.email, this.year);
    const outlookOld = /outlook-(xp|2003|express)/.test(client.id);
    const subject = `${outlookOld ? 'Out of Office AutoReply' : 'Automatic reply'}: ${incoming.subject}`;
    const body = [
      `Thank you for your email. I am out of the office until ${backText} with limited access to email.`,
      '',
      colleague
        ? `For anything urgent, please contact ${colleague.name} (${colleague.email}).`
        : `For anything urgent, please call ${customer.organisation || 'our office'} on the main number.`,
      '',
      customer.name,
    ].join('\n');
    return this.sendDraft({
      kind: 'ooo',
      sender: customer.email,
      to: [incoming.from],
      cc: [],
      subject,
      body,
      threadId: thread.id,
      inReplyTo: incoming.messageId,
      references: [incoming.messageId],
      headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' },
      followUp: false,
    });
  }

  // ---------- scheduled jobs: customer replies and follow-ups ----------
  // Delays are in scenario time and divided by the pace, so the same settings
  // work for real-time and accelerated runs.

  addJob(job, scenarioMs) {
    job.id = crypto.randomUUID();
    job.due = Date.now() + scenarioMs / this.pace;
    job.scenarioMs = scenarioMs;
    this.data.pending.push(job);
    this.store.save();
    this.armJob(job);
    this.emitStatus();
    return job;
  }

  queueReply(customer, threadId, replyToId, extraMs = 0) {
    const s = this.settings.scenario;
    const ms = randBetween(Number(s.replyDelayMinSec) || 0, Number(s.replyDelayMaxSec) || 0) * 1000 + extraMs;
    const job = this.addJob({ type: 'reply', customer: lc(customer.email), threadId, replyToId }, ms);
    if (this.running) this.log('info', `${customer.name} will reply in ${fmtWait(job.due - Date.now())}`);
    else this.log('info', `${customer.name} will reply once the scenario is started`);
  }

  // Chase an unanswered customer email after a random wait.
  // Whether this customer or party chases at all (Settings → Follow-ups, and per customer).
  chases(contact) {
    const s = this.settings.scenario;
    if (!s.followUpEnabled || contact.followUps === false) return false;
    return contact.kind !== 'party' || !!s.partyFollowUps;
  }

  scheduleFollowUp(customer, threadId, afterId, attempt = 1) {
    const s = this.settings.scenario;
    if (!this.chases(customer) || attempt > (Number(s.followUpMax) || 0)) return;
    // Each chase waits a little longer than the last.
    const hours = randBetween(Number(s.followUpMinHours) || 1, Number(s.followUpMaxHours) || 1) * (1 + 0.5 * (attempt - 1));
    const job = this.addJob({ type: 'followup', customer: lc(customer.email), threadId, afterId, attempt }, hours * 3600000);
    this.log('info', `${customer.name} will chase if no answer within ${fmtWait(job.due - Date.now())}`);
  }

  cancelFollowUps(threadId) {
    const pending = this.data.pending || [];
    for (const job of pending.filter((j) => j.type === 'followup' && j.threadId === threadId)) {
      clearTimeout(this.replyTimers.get(job.id));
      this.replyTimers.delete(job.id);
    }
    this.data.pending = pending.filter((j) => !(j.type === 'followup' && j.threadId === threadId));
    this.store.save();
  }

  armJob(job) {
    if (!this.running) return;
    const run = job.type === 'followup' ? () => this.runFollowUp(job) : () => this.runReply(job);
    const t = setTimeout(run, Math.max(1000, job.due - Date.now()));
    this.replyTimers.set(job.id, t);
  }

  resumePendingReplies() {
    for (const job of this.data.pending || []) this.armJob(job);
  }

  // A job dropped while its AI call was running (conversation ended or removed).
  cancelled(job) {
    return !(this.data.pending || []).some((j) => j.id === job.id);
  }

  finishJob(job) {
    clearTimeout(this.replyTimers.get(job.id));
    this.replyTimers.delete(job.id);
    this.data.pending = (this.data.pending || []).filter((j) => j.id !== job.id);
    this.store.save();
    this.emitStatus();
  }

  // Delay a job until working hours (real-time pace only). Returns true if deferred.
  deferToWorkingHours(job) {
    if (this.inWorkingHours()) return false;
    job.due = this.nextWorkingTime();
    this.store.save();
    this.armJob(job);
    return true;
  }

  async runReply(job) {
    if (!this.running) {
      // Stays in the pending list and resumes on next start.
      this.replyTimers.delete(job.id);
      return;
    }
    try {
      const customer = this.contactMap().get(job.customer);
      const thread = this.data.threads[job.threadId];
      const idx = thread ? thread.messages.findIndex((m) => m.messageId === job.replyToId) : -1;
      if (!customer || idx < 0) return;
      const incoming = thread.messages[idx];

      // If the employee wrote again before we answered, answer the latest message only.
      const later = thread.messages.slice(idx + 1);
      if (later.some((m) => m.direction === 'in' || (m.from === job.customer && m.kind !== 'ooo'))) return;

      const s = this.settings.scenario;
      const colleagues = this.colleaguesOf(customer);
      const r = await ai.writeCustomerReply(this.settings.openai, {
        company: this.aiCompany(),
        customer,
        colleagues,
        thread,
        incoming,
        guidance: s.guidance,
        now: this.nowText(),
        allowDocuments: s.allowDocuments !== false,
        allowMeetings: s.allowMeetings !== false,
      });
      if (this.cancelled(job)) return;
      if (!r.shouldReply || !r.body) {
        this.setStatus(thread, 'resolved');
        if (r.remember) this.remember(customer.email, r.remember);
        this.store.save();
        this.log('info', `${customer.name} considers "${thread.subject}" finished; no reply.`);
        return;
      }

      // Reply-all: company addresses plus colleagues who were on the message.
      const company = this.companyDomains();
      const colleagueSet = new Set(colleagues.map((c) => lc(c.email)));
      const ccSet = new Set([...incoming.to, ...(incoming.cc || [])].filter((e) => company.has(domainOf(e)) || colleagueSet.has(e)));
      for (const e of [].concat(r.ccColleagues || []).map(lc)) if (colleagueSet.has(e)) ccSet.add(e);
      ccSet.delete(incoming.from);
      ccSet.delete(lc(customer.email));

      await this.submit({
        kind: 'reply',
        sender: customer.email,
        to: [incoming.from],
        cc: [...ccSet],
        subject: 'Re: ' + baseSubject(incoming.subject),
        body: r.body,
        threadId: thread.id,
        quotedId: incoming.messageId,
        inReplyTo: incoming.messageId,
        references: thread.messages.map((m) => m.messageId).slice(-10),
        followUp: r.expectsResponse !== false,
        resolves: r.expectsResponse === false,
        remember: r.remember,
        document: s.allowDocuments !== false ? r.document : null,
        meeting: s.allowMeetings !== false ? r.meeting : null,
        forms: formAnswers(r.fillForms, incoming),
      });
    } catch (e) {
      this.log('error', `Reply failed: ${e.message}`);
    } finally {
      this.finishJob(job);
    }
  }

  async runFollowUp(job) {
    if (!this.running) {
      this.replyTimers.delete(job.id);
      return;
    }
    if (this.deferToWorkingHours(job)) return;
    try {
      const customer = this.contactMap().get(job.customer);
      const thread = this.data.threads[job.threadId];
      const idx = thread ? thread.messages.findIndex((m) => m.messageId === job.afterId) : -1;
      if (!customer || idx < 0) return;
      // Chasing switched off since this was queued.
      if (!this.chases(customer)) return;
      // Answered (or already chased) since: nothing to do.
      if (idx !== thread.messages.length - 1) return;
      const last = thread.messages[idx];

      const staff = this.employeeMap();
      const colleagues = this.colleaguesOf(customer);
      const r = await ai.writeFollowUp(this.settings.openai, {
        company: this.aiCompany(),
        customer,
        colleagues,
        thread,
        attempt: job.attempt,
        waited: fmtWait(job.scenarioMs),
        guidance: this.settings.scenario.guidance,
        now: this.nowText(),
      });
      if (!r.body || this.cancelled(job)) return;

      const to = last.to.filter((e) => staff.has(e));
      if (!to.length) return;
      // Escalation: a senior colleague sends the chase instead, copying the original sender.
      const escalateTo = job.attempt >= 2 && colleagues.find((c) => lc(c.email) === lc(r.escalateTo));
      const sender = escalateTo || customer;
      const cc = [...new Set([...(last.cc || []), ...[].concat(r.addCc || []).map(lc)])]
        .filter((e) => (staff.has(e) || colleagues.some((c) => lc(c.email) === e)) && !to.includes(e) && e !== lc(sender.email))
        .slice(0, 3);
      if (escalateTo && !cc.includes(lc(customer.email))) cc.push(lc(customer.email));

      await this.submit({
        kind: 'followup',
        sender: sender.email,
        to,
        cc,
        subject: 'Re: ' + baseSubject(last.subject),
        body: r.body,
        threadId: thread.id,
        quotedId: last.messageId,
        inReplyTo: last.messageId,
        references: thread.messages.map((m) => m.messageId).slice(-10),
        followUp: true,
        followUpAttempt: job.attempt,
        remember: r.remember,
      });
      this.log('info', `${sender.name} chased "${thread.subject}" (follow-up ${job.attempt}${escalateTo ? `, escalated from ${customer.name}` : ''})`);
    } catch (e) {
      this.log('error', `Follow-up failed: ${e.message}`);
    } finally {
      this.finishJob(job);
    }
  }

  // ---------- scripted injects ----------
  //
  // inject = { id, at (minutes after exercise start), title, type: 'email' | 'guidance',
  //   from, to[], cc[], mode: 'brief' | 'exact', subject, body, expectReply,
  //   guidanceMode: 'replace' | 'append', status: 'pending' | 'sent' | 'failed', firedAt, error }

  setInjects(list) {
    const old = new Map((this.data.injects || []).map((i) => [i.id, i]));
    this.data.injects = (list || []).map((i) => {
      const prev = old.get(i.id) || {};
      return {
        id: i.id || crypto.randomUUID(),
        at: Math.max(0, Number(i.at) || 0),
        title: String(i.title || ''),
        type: i.type === 'guidance' ? 'guidance' : 'email',
        from: lc(i.from),
        to: [].concat(i.to || []).map(lc).filter(Boolean),
        cc: [].concat(i.cc || []).map(lc).filter(Boolean),
        mode: i.mode === 'exact' ? 'exact' : 'brief',
        subject: String(i.subject || ''),
        body: String(i.body || ''),
        expectReply: i.expectReply !== false,
        guidanceMode: i.guidanceMode === 'append' ? 'append' : 'replace',
        status: prev.status || 'pending',
        ...(prev.firedAt ? { firedAt: prev.firedAt, firedAtMs: prev.firedAtMs } : {}),
        ...(prev.error ? { error: prev.error } : {}),
      };
    }).sort((a, b) => a.at - b.at);
    this.store.save();
    this.emit('injects-changed');
    this.emitStatus();
    return this.data.injects;
  }

  checkInjects() {
    if (!this.running || this.firingInjects) return;
    const elapsed = this.exerciseElapsed();
    const due = (this.data.injects || []).filter((i) => i.status === 'pending' && i.at * 60000 <= elapsed);
    if (!due.length) return;
    this.firingInjects = true;
    (async () => {
      for (const i of due) await this.fireInject(i.id);
    })().finally(() => { this.firingInjects = false; });
  }

  async fireInject(id) {
    const inj = (this.data.injects || []).find((i) => i.id === id);
    if (!inj) throw new Error('Inject not found.');
    const label = inj.title || inj.subject || (inj.type === 'guidance' ? 'guidance change' : 'email');
    try {
      if (inj.type === 'guidance') {
        const s = this.settings.scenario;
        s.guidance = inj.guidanceMode === 'append' && s.guidance ? `${s.guidance}\n${inj.body}` : inj.body;
        this.emit('settings-changed');
      } else if (inj.mode === 'exact') {
        const sender = this.contactMap().get(inj.from);
        if (!sender) throw new Error(`Unknown sender ${inj.from || '(none chosen)'}`);
        if (!inj.to.length) throw new Error('No recipient chosen.');
        if (!inj.subject || !inj.body) throw new Error('Exact emails need a subject and body.');
        await this.sendDraft({ kind: 'inject', sender: sender.email, to: inj.to, cc: inj.cc, subject: inj.subject, body: inj.body, followUp: inj.expectReply });
      } else {
        if (!inj.body && !inj.subject) throw new Error('Describe what the email should be about.');
        const customers = this.store.customers || [];
        const sender = inj.from || (customers.length ? lc(pick(customers).email) : '');
        if (!sender) throw new Error('No sender chosen and no customers defined.');
        await this.generateEvent(sender, { brief: [inj.subject, inj.body].filter(Boolean).join('\n'), to: inj.to, skipReview: true });
      }
      inj.status = 'sent';
      inj.firedAt = new Date().toISOString();
      inj.firedAtMs = this.exerciseElapsed();
      delete inj.error;
      this.log('info', `Inject fired at T+${Math.round(this.exerciseElapsed() / 60000)} min: ${label}`);
    } catch (e) {
      inj.status = 'failed';
      inj.error = e.message;
      this.log('error', `Inject "${label}" failed: ${e.message}`);
    }
    this.store.save();
    this.emit('injects-changed');
    this.emitStatus();
    return inj;
  }

  // ---------- manual actions ----------

  async sendNow(customerEmail) {
    this.validate();
    await this.generateEvent(customerEmail);
  }

  async backgroundNow() {
    this.validate();
    await this.generateBackground();
  }

  // Swap in a whole scenario loaded from a .senario file or a template.
  async loadSnapshot(snapshot, opts) {
    await this.stop();
    for (const t of this.replyTimers.values()) clearTimeout(t);
    this.replyTimers.clear();
    this.store.replaceAll(snapshot, opts);
    await this.restartListener().catch(() => {});
    this.emit('threads-changed');
    this.emit('outbox-changed');
    this.emit('injects-changed');
    this.emitStatus();
  }

  // Ending a conversation marks it resolved and drops its queued replies, chases and
  // held drafts, so the customer is free to start another. If an employee writes in
  // it again, it reopens as usual.
  endThread(id) {
    const thread = this.data.threads[id];
    if (!thread) throw new Error('That conversation no longer exists.');
    this.dropThreadWork(id);
    this.setStatus(thread, 'resolved');
    this.store.save();
    this.log('info', `Conversation "${thread.subject}" ended.`);
    this.emit('threads-changed');
    this.emitStatus();
  }

  // Removing forgets the conversation entirely. Mail already delivered is not touched;
  // a later reply to it starts a new conversation.
  removeThread(id) {
    const thread = this.data.threads[id];
    if (!thread) throw new Error('That conversation no longer exists.');
    this.dropThreadWork(id);
    delete this.data.threads[id];
    for (const [msgId, tid] of Object.entries(this.data.msgIndex)) if (tid === id) delete this.data.msgIndex[msgId];
    this.store.save();
    this.log('info', `Conversation "${thread.subject}" removed.`);
    this.emit('threads-changed');
    this.emitStatus();
  }

  dropThreadWork(id) {
    for (const job of (this.data.pending || []).filter((j) => j.threadId === id)) {
      clearTimeout(this.replyTimers.get(job.id));
      this.replyTimers.delete(job.id);
    }
    this.data.pending = (this.data.pending || []).filter((j) => j.threadId !== id);
    const before = (this.data.outbox || []).length;
    this.data.outbox = (this.data.outbox || []).filter((d) => d.threadId !== id);
    if (this.data.outbox.length !== before) this.emit('outbox-changed');
  }

  resetConversations() {
    for (const t of this.replyTimers.values()) clearTimeout(t);
    this.replyTimers.clear();
    this.store.resetConversations();
    this.log('info', 'Conversation history cleared.');
    this.emit('outbox-changed');
    this.emitStatus();
  }
}

// The AI's form answers, tied to the forms on the message being replied to.
// fillForms: [{ file, answers: { [field id]: value } }] -> [{ messageId, idx, answers }]
function formAnswers(fillForms, incoming) {
  const forms = (incoming.attachments || []).map((a, idx) => ({ a, idx })).filter((x) => x.a.form);
  const out = [];
  for (const f of Array.isArray(fillForms) ? fillForms : []) {
    if (!f || typeof f.answers !== 'object' || !f.answers) continue;
    const match = forms.find((x) => lc(x.a.filename) === lc(f.file)) || (forms.length === 1 ? forms[0] : null);
    if (!match || out.some((o) => o.idx === match.idx)) continue;
    const ids = new Set(match.a.form.fields.map((x) => x.id));
    const answers = Object.fromEntries(Object.entries(f.answers)
      .filter(([id, v]) => ids.has(id) && v !== null && v !== undefined && String(v).trim() !== '')
      .map(([id, v]) => [id, String(v).slice(0, 500)]));
    if (Object.keys(answers).length) out.push({ messageId: incoming.messageId, idx: match.idx, answers });
  }
  return out.length ? out : undefined;
}

module.exports = { Engine, stripQuoted, baseSubject };
