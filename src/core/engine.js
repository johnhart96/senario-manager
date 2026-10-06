'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const mail = require('./mail');
const ai = require('./ai');
const { extractAttachments } = require('./attachments');
const clock = require('./clock');
const { compose } = require('./compose');

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
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

const baseSubject = (s) => String(s || '').replace(/^\s*((re|fw|fwd|aw)\s*:\s*)+/i, '').trim();

class Engine extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.running = false;
    this.genTimer = null;
    this.replyTimers = new Map();
    this.listener = null;
    this.listenerError = null;
    this.nextEventAt = null;
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

  // Customers may only ever email addresses inside the scenario company.
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

  nowText() {
    return clock.formatScenario(new Date(), this.year);
  }

  status() {
    const l = this.settings.listener;
    return {
      running: this.running,
      nextEventAt: this.nextEventAt,
      pendingReplies: (this.store.data.pending || []).length,
      threads: Object.keys(this.store.data.threads).length,
      listening: this.listener ? `${l.bindAddress}:${l.port}` : null,
      listenerError: this.listenerError || null,
      allowedSources: this.listener ? this.listener.allowed : [],
      pace: this.pace,
      operatingYear: this.year,
      clockOffsetMs: clock.offsetMs(this.year),
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
    this.log('info', `Scenario started. Sending via ${mail.serverHost(this.settings.mail)}:${this.settings.mail.smtpPort}`);
    this.scheduleNextEvent();
    this.resumePendingReplies();
    this.emitStatus();
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.genTimer);
    for (const t of this.replyTimers.values()) clearTimeout(t);
    this.replyTimers.clear();
    this.nextEventAt = null;
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

  scheduleNextEvent() {
    if (!this.running) return;
    const s = this.settings.scenario;
    const mins = randBetween(Number(s.minIntervalMin) || 1, Number(s.maxIntervalMin) || 1);
    this.armNextEvent((mins * 60000) / this.pace);
  }

  armNextEvent(ms) {
    clearTimeout(this.genTimer);
    ms = Math.max(5000, ms);
    this.nextEventAt = new Date(Date.now() + ms).toISOString();
    this.genTimer = setTimeout(async () => {
      if (this.inWorkingHours()) {
        await this.generateEvent().catch((e) => this.log('error', 'Generate failed: ' + e.message));
      }
      this.scheduleNextEvent();
    }, ms);
    this.emitStatus();
  }

  // Change pace live: everything already scheduled is rescaled to the new speed.
  setPace(newPace) {
    const oldPace = this.pace;
    this.settings.scenario.pace = Math.max(1, Number(newPace) || 1);
    this.store.save();
    const ratio = oldPace / this.pace;
    if (ratio === 1) return this.status();
    const now = Date.now();
    for (const job of this.store.data.pending || []) {
      job.due = now + Math.max(0, job.due - now) * ratio;
      if (this.replyTimers.has(job.id)) {
        clearTimeout(this.replyTimers.get(job.id));
        this.armJob(job);
      }
    }
    this.store.save();
    if (this.running && this.nextEventAt) {
      this.armNextEvent(Math.max(0, Date.parse(this.nextEventAt) - now) * ratio);
    }
    this.log('info', this.pace === 1 ? 'Pace set to real business time.' : `Pace set to ${this.pace}× faster than real time.`);
    this.emitStatus();
    return this.status();
  }

  // ---------- outgoing (customer → company) ----------

  // body is the new text only; quoted is the thread message being replied to (if any).
  async deliver({ customer, to, cc = [], subject, body, quoted = null, threadId, inReplyTo, references = [] }) {
    const allowed = this.companyDomains();
    const blocked = [...to, ...cc].filter((e) => !allowed.has(domainOf(e)));
    if (blocked.length) {
      throw new Error(`Refusing to send to address(es) outside the company: ${blocked.join(', ')}`);
    }
    const messageId = `<${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}@${domainOf(customer.email)}>`;
    const staff = this.employeeMap();
    const fmt = (e) => (staff.get(e) ? { name: staff.get(e).name, address: e } : e);
    const date = new Date();
    const people = new Map([...staff].map(([e, p]) => [e, p.name]));
    for (const [e, c] of this.contactMap()) people.set(e, c.name);
    const content = compose({
      body,
      sender: customer,
      quoted,
      format: this.settings.scenario.emailFormat === 'text' ? 'text' : 'html',
      year: this.year,
      nameOf: (e) => people.get(lc(e)) || '',
    });
    this.store.data.sentIds[messageId] = Date.now();
    await mail.sendMail(this.settings.mail, {
      messageId,
      date: this.year && this.company.datedEmails !== false ? clock.toScenario(date, this.year) : date,
      envelope: { from: customer.email, to: [...to, ...cc] },
      from: { name: customer.name, address: customer.email },
      to: to.map(fmt),
      cc: cc.map(fmt),
      subject,
      text: content.text,
      html: content.html,
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
      direction: 'out',
    };
    const thread = this.addToThread(threadId, record, subject, customer.email);
    const who = customer.kind === 'party' ? `${customer.name} (${customer.organisation}, ${customer.role || 'external party'})` : `${customer.name} (${customer.organisation})`;
    this.log('send', `${who} → ${[...to, ...cc].join(', ')}: "${subject}"`);
    this.emit('threads-changed');
    this.emitStatus();
    return { thread, record };
  }

  addToThread(threadId, record, subject, customerEmail) {
    const data = this.store.data;
    let thread = threadId && data.threads[threadId];
    if (!thread) {
      threadId = threadId || crypto.randomUUID();
      thread = { id: threadId, subject: baseSubject(subject), customer: lc(customerEmail), messages: [], updatedAt: record.date };
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
    const match = Object.values(this.store.data.threads)
      .filter((t) => t.subject.toLowerCase() === base && addrs.has(t.customer))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    return match && match.id;
  }

  historyFor(customerEmail) {
    return Object.values(this.store.data.threads)
      .filter((t) => t.customer === lc(customerEmail))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, 10)
      .map((t) => t.subject);
  }

  // One unsolicited email from a random customer. External parties never start
  // conversations, so they are never picked here.
  async generateEvent(customerEmail) {
    const customers = this.store.customers || [];
    const staff = this.employeeMap();
    if (!customers.length) {
      if (customerEmail) throw new Error('No customers defined.');
      return this.log('info', 'No customers defined, so no new emails are started (external parties only reply).');
    }
    if (!staff.size) throw new Error('No employees defined.');
    if (customerEmail && !this.customerMap().has(lc(customerEmail))) {
      throw new Error('Only customers start conversations; external parties only reply.');
    }

    const customer = { ...((customerEmail && this.customerMap().get(lc(customerEmail))) || pick(customers)), kind: 'customer' };
    this.log('info', `Composing email from ${customer.name} (${customer.organisation})…`);
    const draft = await ai.writeCustomerEmail(this.settings.openai, {
      company: { ...this.company, employees: this.employees() },
      customer,
      history: this.historyFor(customer.email),
      guidance: this.settings.scenario.guidance,
      now: this.nowText(),
    });
    if (!draft.subject || !draft.body) throw new Error('Model returned an empty email.');

    // Only real employees may be addressed; fall back to a random one if the model strays.
    let to = lc(draft.to);
    if (!staff.has(to)) to = lc(pick(this.employees()).email);
    const cc = [].concat(draft.cc || []).map(lc).filter((e) => staff.has(e) && e !== to).slice(0, 2);

    const { thread, record } = await this.deliver({ customer, to: [to], cc, subject: draft.subject, body: draft.body });
    this.scheduleFollowUp(customer, thread.id, record.messageId);
  }

  // ---------- incoming (company → customer) ----------

  async handleIncoming(parsed, envelope) {
    const data = this.store.data;
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

    // Read attachments (quotes, invoices, spreadsheets...) so the customer can respond to them.
    const attachments = await extractAttachments(parsed.attachments, {
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
      direction: 'in',
      attachments,
    };
    const thread = this.addToThread(threadId, record, subject, customer ? customer.email : rcpt[0]);
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
    this.queueReply(customer, thread.id, messageId);
  }

  // ---------- scheduled jobs: customer replies and follow-ups ----------
  // Delays are in scenario time and divided by the pace, so the same settings
  // work for real-time and accelerated runs.

  addJob(job, scenarioMs) {
    job.id = crypto.randomUUID();
    job.due = Date.now() + scenarioMs / this.pace;
    job.scenarioMs = scenarioMs;
    this.store.data.pending.push(job);
    this.store.save();
    this.armJob(job);
    this.emitStatus();
    return job;
  }

  queueReply(customer, threadId, replyToId) {
    const s = this.settings.scenario;
    const ms = randBetween(Number(s.replyDelayMinSec) || 0, Number(s.replyDelayMaxSec) || 0) * 1000;
    const job = this.addJob({ type: 'reply', customer: lc(customer.email), threadId, replyToId }, ms);
    if (this.running) this.log('info', `${customer.name} will reply in ${fmtWait(job.due - Date.now())}`);
    else this.log('info', `${customer.name} will reply once the scenario is started`);
  }

  // Chase an unanswered customer email after a random wait.
  scheduleFollowUp(customer, threadId, afterId, attempt = 1) {
    const s = this.settings.scenario;
    if (!s.followUpEnabled || attempt > (Number(s.followUpMax) || 0)) return;
    if (customer.kind === 'party' && !s.partyFollowUps) return;
    // Each chase waits a little longer than the last.
    const hours = randBetween(Number(s.followUpMinHours) || 1, Number(s.followUpMaxHours) || 1) * (1 + 0.5 * (attempt - 1));
    const job = this.addJob({ type: 'followup', customer: lc(customer.email), threadId, afterId, attempt }, hours * 3600000);
    this.log('info', `${customer.name} will chase if no answer within ${fmtWait(job.due - Date.now())}`);
  }

  cancelFollowUps(threadId) {
    const pending = this.store.data.pending || [];
    for (const job of pending.filter((j) => j.type === 'followup' && j.threadId === threadId)) {
      clearTimeout(this.replyTimers.get(job.id));
      this.replyTimers.delete(job.id);
    }
    this.store.data.pending = pending.filter((j) => !(j.type === 'followup' && j.threadId === threadId));
    this.store.save();
  }

  armJob(job) {
    if (!this.running) return;
    const run = job.type === 'followup' ? () => this.runFollowUp(job) : () => this.runReply(job);
    const t = setTimeout(run, Math.max(1000, job.due - Date.now()));
    this.replyTimers.set(job.id, t);
  }

  resumePendingReplies() {
    for (const job of this.store.data.pending || []) this.armJob(job);
  }

  finishJob(job) {
    this.replyTimers.delete(job.id);
    this.store.data.pending = (this.store.data.pending || []).filter((j) => j.id !== job.id);
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
      const thread = this.store.data.threads[job.threadId];
      const idx = thread ? thread.messages.findIndex((m) => m.messageId === job.replyToId) : -1;
      if (!customer || idx < 0) return;
      const incoming = thread.messages[idx];

      // If the employee wrote again before we answered, answer the latest message only.
      const later = thread.messages.slice(idx + 1);
      if (later.some((m) => m.direction === 'in' || m.from === job.customer)) return;

      const r = await ai.writeCustomerReply(this.settings.openai, {
        company: { ...this.company, employees: this.employees() },
        customer,
        thread,
        incoming,
        guidance: this.settings.scenario.guidance,
        now: this.nowText(),
      });
      if (!r.shouldReply || !r.body) {
        this.log('info', `${customer.name} considers "${thread.subject}" finished; no reply.`);
        return;
      }

      // Reply-all, but only to people inside the company.
      const company = this.companyDomains();
      const ccSet = new Set([...incoming.to, ...(incoming.cc || [])].filter((e) => company.has(domainOf(e))));
      ccSet.delete(incoming.from);
      const refs = thread.messages.map((m) => m.messageId).slice(-10);

      const { record } = await this.deliver({
        customer,
        to: [incoming.from],
        cc: [...ccSet],
        subject: 'Re: ' + baseSubject(incoming.subject),
        body: r.body,
        quoted: incoming,
        threadId: thread.id,
        inReplyTo: incoming.messageId,
        references: refs,
      });
      if (r.expectsResponse !== false) this.scheduleFollowUp(customer, thread.id, record.messageId);
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
      const thread = this.store.data.threads[job.threadId];
      const idx = thread ? thread.messages.findIndex((m) => m.messageId === job.afterId) : -1;
      if (!customer || idx < 0) return;
      // Answered (or already chased) since: nothing to do.
      if (idx !== thread.messages.length - 1) return;
      const last = thread.messages[idx];

      const staff = this.employeeMap();
      const r = await ai.writeFollowUp(this.settings.openai, {
        company: { ...this.company, employees: this.employees() },
        customer,
        thread,
        attempt: job.attempt,
        waited: fmtWait(job.scenarioMs),
        guidance: this.settings.scenario.guidance,
        now: this.nowText(),
      });
      if (!r.body) return;

      const to = last.to.filter((e) => staff.has(e));
      if (!to.length) return;
      const cc = [...new Set([...(last.cc || []), ...[].concat(r.addCc || []).map(lc)])]
        .filter((e) => staff.has(e) && !to.includes(e))
        .slice(0, 3);

      const { record } = await this.deliver({
        customer,
        to,
        cc,
        subject: 'Re: ' + baseSubject(last.subject),
        body: r.body,
        quoted: last,
        threadId: thread.id,
        inReplyTo: last.messageId,
        references: thread.messages.map((m) => m.messageId).slice(-10),
      });
      this.log('info', `${customer.name} chased "${thread.subject}" (follow-up ${job.attempt})`);
      this.scheduleFollowUp(customer, thread.id, record.messageId, job.attempt + 1);
    } catch (e) {
      this.log('error', `Follow-up failed: ${e.message}`);
    } finally {
      this.finishJob(job);
    }
  }

  // ---------- manual actions ----------

  async sendNow(customerEmail) {
    this.validate();
    await this.generateEvent(customerEmail);
  }

  // Swap in a whole scenario loaded from a .senario file.
  async loadSnapshot(snapshot, opts) {
    await this.stop();
    for (const t of this.replyTimers.values()) clearTimeout(t);
    this.replyTimers.clear();
    this.store.replaceAll(snapshot, opts);
    await this.restartListener().catch(() => {});
    this.emit('threads-changed');
    this.emitStatus();
  }

  resetConversations() {
    for (const t of this.replyTimers.values()) clearTimeout(t);
    this.replyTimers.clear();
    this.store.resetConversations();
    this.log('info', 'Conversation history cleared.');
    this.emitStatus();
  }
}

module.exports = { Engine, stripQuoted };
