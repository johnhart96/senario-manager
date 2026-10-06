'use strict';

// .senario files: a complete snapshot of the app (settings, company, customers,
// conversations and scheduled jobs) stored as an SQLite database.

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const FORMAT = 'senario';
const FORMAT_VERSION = 1;

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE settings (section TEXT PRIMARY KEY, value TEXT NOT NULL);       -- JSON per section
CREATE TABLE company (
  id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT, domain TEXT, description TEXT,
  operating_year INTEGER, dated_emails INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE employees (
  position INTEGER PRIMARY KEY, name TEXT, email TEXT NOT NULL, role TEXT, responsibilities TEXT
);
CREATE TABLE customers (
  position INTEGER PRIMARY KEY, name TEXT, email TEXT NOT NULL, organisation TEXT, role TEXT,
  relationship TEXT, personality TEXT, writing_style TEXT, signature TEXT
);
CREATE TABLE parties (
  position INTEGER PRIMARY KEY, name TEXT, email TEXT NOT NULL, organisation TEXT, role TEXT,
  services TEXT, personality TEXT, writing_style TEXT, signature TEXT
);
CREATE TABLE threads (id TEXT PRIMARY KEY, subject TEXT, customer TEXT, updated_at TEXT);
CREATE TABLE messages (
  message_id TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES threads(id), position INTEGER NOT NULL,
  direction TEXT NOT NULL, from_addr TEXT, from_name TEXT, to_addrs TEXT, cc_addrs TEXT,
  subject TEXT, body TEXT, date TEXT,
  PRIMARY KEY (thread_id, position)
);
CREATE INDEX messages_by_id ON messages (message_id);
CREATE TABLE pending_jobs (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, customer TEXT, thread_id TEXT, ref_message_id TEXT,
  attempt INTEGER, remaining_ms INTEGER NOT NULL, scenario_ms INTEGER
);
CREATE TABLE attachments (
  thread_id TEXT NOT NULL, position INTEGER NOT NULL, idx INTEGER NOT NULL,
  filename TEXT, content_type TEXT, size INTEGER, kind TEXT, status TEXT, text TEXT, truncated INTEGER, error TEXT,
  PRIMARY KEY (thread_id, position, idx)
);
CREATE TABLE activity_log (id INTEGER PRIMARY KEY, time TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL);
CREATE TABLE seen_messages (message_id TEXT PRIMARY KEY, kind TEXT NOT NULL, at INTEGER); -- sent | processed
`;

// Settings fields that hold credentials; only written when explicitly requested.
const SECRETS = [
  ['openai', 'apiKey'],
  ['mail', 'password'],
];

function saveSenario(file, data, { includeSecrets = false, appVersion = '' } = {}) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  try {
    db.exec(SCHEMA);
    db.exec('BEGIN');

    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    meta.run('format', FORMAT);
    meta.run('format_version', String(FORMAT_VERSION));
    meta.run('app_version', appVersion);
    meta.run('saved_at', new Date().toISOString());
    meta.run('includes_credentials', includeSecrets ? '1' : '0');

    const settings = JSON.parse(JSON.stringify(data.settings));
    if (!includeSecrets) for (const [a, b] of SECRETS) if (settings[a]) settings[a][b] = '';
    const setting = db.prepare('INSERT INTO settings (section, value) VALUES (?, ?)');
    for (const [section, value] of Object.entries(settings)) setting.run(section, JSON.stringify(value));

    const c = data.company || {};
    db.prepare('INSERT INTO company (id, name, domain, description, operating_year, dated_emails) VALUES (1, ?, ?, ?, ?, ?)').run(
      c.name || '', c.domain || '', c.description || '', Number(c.operatingYear) || null, c.datedEmails === false ? 0 : 1
    );
    const emp = db.prepare('INSERT INTO employees VALUES (?, ?, ?, ?, ?)');
    (c.employees || []).forEach((e, i) => emp.run(i, e.name || '', e.email, e.role || '', e.responsibilities || ''));

    const cust = db.prepare('INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    (data.customers || []).forEach((x, i) =>
      cust.run(i, x.name || '', x.email, x.organisation || '', x.role || '', x.relationship || '',
        x.personality || '', x.writingStyle || '', x.signature || '')
    );

    const party = db.prepare('INSERT INTO parties VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    (data.parties || []).forEach((x, i) =>
      party.run(i, x.name || '', x.email, x.organisation || '', x.role || '', x.services || '',
        x.personality || '', x.writingStyle || '', x.signature || '')
    );

    const thread = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)');
    const msg = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const att = db.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const t of Object.values(data.threads || {})) {
      thread.run(t.id, t.subject || '', t.customer || '', t.updatedAt || '');
      t.messages.forEach((m, i) => {
        msg.run(m.messageId, t.id, i, m.direction, m.from || '', m.fromName || '',
          JSON.stringify(m.to || []), JSON.stringify(m.cc || []), m.subject || '', m.body || '', m.date || '');
        (m.attachments || []).forEach((a, k) =>
          att.run(t.id, i, k, a.filename || '', a.contentType || '', a.size || 0, a.kind || '', a.status || '',
            a.text || '', a.truncated ? 1 : 0, a.error || '')
        );
      });
    }

    // Jobs keep the time they had left, so a loaded scenario resumes where it was.
    const now = Date.now();
    const job = db.prepare('INSERT INTO pending_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const j of data.pending || []) {
      job.run(j.id, j.type || 'reply', j.customer || '', j.threadId || '', j.replyToId || j.afterId || '',
        j.attempt || 0, Math.max(0, Math.round(j.due - now)), Math.round(j.scenarioMs || 0));
    }

    const seen = db.prepare('INSERT OR IGNORE INTO seen_messages VALUES (?, ?, ?)');
    for (const [id, at] of Object.entries(data.sentIds || {})) seen.run(id, 'sent', at);
    for (const [id, at] of Object.entries(data.processedIds || {})) seen.run(id, 'processed', at);

    const log = db.prepare('INSERT INTO activity_log (time, level, message) VALUES (?, ?, ?)');
    for (const l of data.log || []) log.run(l.time, l.level, l.message);

    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
    db.close();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  db.close();
  fs.renameSync(tmp, file);
}

function loadSenario(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
    if (meta.format !== FORMAT) throw new Error('not a senario file');
    if (Number(meta.format_version) > FORMAT_VERSION) {
      throw new Error(`it was saved by a newer version of Senario Manager (format ${meta.format_version})`);
    }

    const settings = {};
    for (const r of db.prepare('SELECT section, value FROM settings').all()) settings[r.section] = JSON.parse(r.value);

    // SELECT * so files from before operating_year existed still load.
    const c = db.prepare('SELECT * FROM company WHERE id = 1').get() || {};
    const company = {
      name: c.name || '',
      domain: c.domain || '',
      description: c.description || '',
      operatingYear: c.operating_year ? Number(c.operating_year) : null,
      datedEmails: c.dated_emails === undefined || c.dated_emails === null ? true : !!c.dated_emails,
      employees: db.prepare('SELECT name, email, role, responsibilities FROM employees ORDER BY position').all()
        .map((e) => ({ ...e })),
    };

    const customers = db.prepare('SELECT * FROM customers ORDER BY position').all().map((x) => ({
      name: x.name, email: x.email, organisation: x.organisation, role: x.role, relationship: x.relationship,
      personality: x.personality, writingStyle: x.writing_style, signature: x.signature,
    }));

    const threads = {};
    const msgIndex = {};
    for (const t of db.prepare('SELECT * FROM threads').all()) {
      threads[t.id] = { id: t.id, subject: t.subject, customer: t.customer, updatedAt: t.updated_at, messages: [] };
    }
    for (const m of db.prepare('SELECT * FROM messages ORDER BY thread_id, position').all()) {
      const t = threads[m.thread_id];
      if (!t) continue;
      t.messages.push({
        messageId: m.message_id, direction: m.direction, from: m.from_addr, fromName: m.from_name,
        to: JSON.parse(m.to_addrs || '[]'), cc: JSON.parse(m.cc_addrs || '[]'),
        subject: m.subject, body: m.body, date: m.date,
      });
      msgIndex[m.message_id] = t.id;
    }

    // Files saved before attachments were supported simply have none.
    const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (hasTable('attachments')) {
      for (const a of db.prepare('SELECT * FROM attachments ORDER BY thread_id, position, idx').all()) {
        const m = threads[a.thread_id] && threads[a.thread_id].messages[a.position];
        if (!m) continue;
        const item = { filename: a.filename, contentType: a.content_type, size: Number(a.size), kind: a.kind || null,
          status: a.status, text: a.text, truncated: !!a.truncated };
        if (a.error) item.error = a.error;
        (m.attachments = m.attachments || []).push(item);
      }
    }

    const parties = hasTable('parties')
      ? db.prepare('SELECT * FROM parties ORDER BY position').all().map((x) => ({
        name: x.name, email: x.email, organisation: x.organisation, role: x.role, services: x.services,
        personality: x.personality, writingStyle: x.writing_style, signature: x.signature,
      }))
      : [];

    const now = Date.now();
    const pending = db.prepare('SELECT * FROM pending_jobs').all().map((j) => {
      const job = { id: j.id, type: j.type, customer: j.customer, threadId: j.thread_id,
        due: now + Number(j.remaining_ms), scenarioMs: Number(j.scenario_ms) };
      if (j.type === 'followup') Object.assign(job, { afterId: j.ref_message_id, attempt: Number(j.attempt) || 1 });
      else job.replyToId = j.ref_message_id;
      return job;
    });

    const sentIds = {};
    const processedIds = {};
    for (const r of db.prepare('SELECT * FROM seen_messages').all()) {
      (r.kind === 'sent' ? sentIds : processedIds)[r.message_id] = Number(r.at);
    }

    // Files saved before the activity log was added simply have none.
    const log = hasTable('activity_log')
      ? db.prepare('SELECT time, level, message FROM activity_log ORDER BY id').all().map((l) => ({ ...l }))
      : [];

    return {
      meta,
      includesCredentials: meta.includes_credentials === '1',
      data: { settings, company, customers, parties, threads, msgIndex, sentIds, processedIds, pending, log },
    };
  } catch (e) {
    throw new Error(`Could not open ${file}: ${/senario|newer/.test(e.message) ? e.message : 'not a valid .senario file (' + e.message + ')'}`);
  } finally {
    if (db) db.close();
  }
}

module.exports = { saveSenario, loadSenario, SECRETS };
