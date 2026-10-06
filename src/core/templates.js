'use strict';

// Ready-made scenarios in src/templates/*.json: a company, its employees, customers,
// external parties and a few example injects. Loading one starts a new, unsaved
// scenario; mail server, OpenAI and timing settings are kept.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'templates');

function list() {
  return fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))
    .map((t) => ({
      id: t.id,
      name: t.name,
      summary: t.summary,
      year: t.company.operatingYear || null,
      employees: t.company.employees.length,
      customers: t.customers.length,
      parties: t.parties.length,
      injects: (t.injects || []).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function get(id) {
  if (id === 'blank') {
    return { company: { name: '', domain: '', description: '', employees: [] }, customers: [], parties: [], injects: [] };
  }
  const file = path.join(DIR, `${path.basename(String(id))}.json`);
  if (!fs.existsSync(file)) throw new Error(`Unknown template "${id}"`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// A complete store snapshot built from a template plus the current settings.
function snapshot(id, settings) {
  const t = get(id);
  return {
    settings: { ...settings, scenario: { ...settings.scenario, guidance: '' } },
    company: { operatingYear: null, datedEmails: true, ...t.company },
    customers: t.customers.map((c) => ({ memory: [], ...c })),
    parties: t.parties.map((p) => ({ memory: [], ...p })),
    injects: (t.injects || []).map((i) => ({ cc: [], expectReply: true, ...i, id: crypto.randomUUID(), status: 'pending' })),
    threads: {},
    msgIndex: {},
    sentIds: {},
    processedIds: {},
    pending: [],
    outbox: [],
    log: [],
    exercise: { elapsedMs: 0, runningSince: null, startedAt: null },
    dkimKeys: {},
  };
}

module.exports = { list, get, snapshot };
