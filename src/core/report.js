'use strict';

// Trainee performance report: how each employee handled the mail the scenario sent
// them. Response times use the exercise clock (scenario time), so a reply that took
// 2 real minutes at 60x pace counts as 2 hours, which is what it represents.

const clock = require('./clock');

const lc = (s) => String(s || '').toLowerCase();

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmtDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '–';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${String(min % 60).padStart(2, '0')} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Scenario-time position of a message: its exercise clock reading, or (for messages
// recorded before the clock existed) its real timestamp.
const at = (m) => (typeof m.exerciseMs === 'number' ? m.exerciseMs : Date.parse(m.date));

/**
 * data: store.data; company: store.company; contacts: Map email -> contact.
 * Returns { generatedAt, company, year, exerciseMs, totals, employees: [...], threads: [...] }.
 */
function compute({ data, company, contacts, exerciseMs = 0 }) {
  const staff = (company.employees || []).filter((e) => e.email);
  const isStaff = new Set(staff.map((e) => lc(e.email)));
  const nowAt = exerciseMs;
  const per = new Map(staff.map((e) => [lc(e.email), {
    name: e.name, email: lc(e.email), role: e.role,
    received: 0, answered: 0, responseTimes: [], waiting: 0, oldestWaitingMs: null, chasesReceived: 0, resolved: 0, conversations: new Set(),
  }]));
  const threads = [];

  for (const t of Object.values(data.threads || {})) {
    if (t.background) continue;
    const msgs = t.messages;
    const contact = contacts.get(lc(t.customer));
    // Who in the company is handling this thread: the staff member addressed most.
    const counts = {};
    for (const m of msgs) for (const e of [...(m.to || []), ...(m.cc || [])]) if (isStaff.has(lc(e))) counts[lc(e)] = (counts[lc(e)] || 0) + (m.to.includes(e) ? 2 : 1);
    for (const m of msgs) if (m.direction === 'in' && isStaff.has(lc(m.from))) counts[lc(m.from)] = (counts[lc(m.from)] || 0) + 2;
    const owner = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const ownerEmail = owner ? owner[0] : null;

    let firstResponse = null;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.direction !== 'out' || m.kind === 'ooo') continue;
      for (const e of m.to.map(lc).filter((x) => per.has(x))) {
        const p = per.get(e);
        p.received++;
        p.conversations.add(t.id);
        if (m.followUp) p.chasesReceived++;
        // The response: the next message in the thread written by this employee.
        const reply = msgs.slice(i + 1).find((r) => r.direction === 'in' && lc(r.from) === e);
        if (reply) {
          p.answered++;
          const ms = Math.max(0, at(reply) - at(m));
          p.responseTimes.push(ms);
          if (firstResponse === null) firstResponse = ms;
        } else if (!msgs.slice(i + 1).some((r) => r.direction === 'in')) {
          // Nobody from the company has replied since: still waiting on them.
          p.waiting++;
          const age = Math.max(0, nowAt - at(m));
          if (p.oldestWaitingMs === null || age > p.oldestWaitingMs) p.oldestWaitingMs = age;
        }
      }
    }
    const last = msgs[msgs.length - 1];
    const state = t.status === 'resolved'
      ? 'Resolved'
      : last.direction === 'out' ? 'Waiting on company' : 'Waiting on customer';
    if (t.status === 'resolved' && ownerEmail && per.has(ownerEmail)) per.get(ownerEmail).resolved++;
    threads.push({
      subject: t.subject,
      with: contact ? `${contact.name}${contact.organisation ? ` (${contact.organisation})` : ''}` : t.customer,
      kind: contact ? contact.kind : 'unknown',
      handledBy: ownerEmail && per.has(ownerEmail) ? per.get(ownerEmail).name : '–',
      messages: msgs.length,
      chases: msgs.filter((m) => m.followUp).length,
      firstResponseMs: firstResponse,
      state,
      startedAt: at(msgs[0]),
    });
  }

  const employees = [...per.values()].map((p) => ({
    name: p.name,
    email: p.email,
    role: p.role,
    conversations: p.conversations.size,
    received: p.received,
    answered: p.answered,
    answerRate: p.received ? p.answered / p.received : null,
    medianResponseMs: median(p.responseTimes),
    slowestResponseMs: p.responseTimes.length ? Math.max(...p.responseTimes) : null,
    waiting: p.waiting,
    oldestWaitingMs: p.oldestWaitingMs,
    chasesReceived: p.chasesReceived,
    resolved: p.resolved,
  }));
  const all = employees.flatMap((e) => (per.get(e.email).responseTimes));
  return {
    generatedAt: new Date().toISOString(),
    company: company.name,
    year: clock.validYear(company.operatingYear),
    exerciseMs,
    totals: {
      conversations: threads.length,
      received: employees.reduce((n, e) => n + e.received, 0),
      answered: employees.reduce((n, e) => n + e.answered, 0),
      waiting: employees.reduce((n, e) => n + e.waiting, 0),
      chases: threads.reduce((n, t) => n + t.chases, 0),
      resolved: threads.filter((t) => t.state === 'Resolved').length,
      medianResponseMs: median(all),
    },
    employees,
    threads: threads.sort((a, b) => a.startedAt - b.startedAt),
  };
}

// Self-contained HTML (light theme, print-friendly) for export and PDF.
function toHtml(r) {
  const pct = (x) => (x === null ? '–' : `${Math.round(x * 100)}%`);
  const t = r.totals;
  const card = (label, value) => `<div class="card"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(r.company)}: exercise report</title>
<style>
  body { font: 13px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1d2330; margin: 32px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 28px 0 10px; }
  .muted { color: #667085; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 18px; }
  .card { border: 1px solid #d6dae1; border-radius: 8px; padding: 10px 14px; min-width: 120px; }
  .card .v { font-size: 20px; font-weight: 600; } .card .l { color: #667085; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e4e7ec; vertical-align: top; }
  th { background: #f2f4f7; font-weight: 600; font-size: 12px; } td.n, th.n { text-align: right; white-space: nowrap; }
  .bad { color: #b42318; font-weight: 600; } .ok { color: #067647; }
  @media print { body { margin: 12mm; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
</style></head><body>
<h1>${esc(r.company)}: exercise report</h1>
<div class="muted">Exercise time T+${esc(fmtDuration(r.exerciseMs))}${r.year ? ` · operating year ${r.year}` : ''} · generated ${esc(new Date(r.generatedAt).toLocaleString('en-GB'))}</div>
<div class="cards">
  ${card('Conversations', t.conversations)}${card('Emails to staff', t.received)}${card('Answered', `${t.answered} (${pct(t.received ? t.answered / t.received : null)})`)}
  ${card('Median response', fmtDuration(t.medianResponseMs))}${card('Still waiting', t.waiting)}${card('Chases sent', t.chases)}${card('Resolved', t.resolved)}
</div>
<h2>By employee</h2>
<table><thead><tr><th>Employee</th><th class="n">Conversations</th><th class="n">Emails</th><th class="n">Answered</th><th class="n">Median response</th><th class="n">Slowest</th><th class="n">Waiting</th><th class="n">Oldest waiting</th><th class="n">Chases</th><th class="n">Resolved</th></tr></thead><tbody>
${r.employees.map((e) => `<tr><td><b>${esc(e.name)}</b><br><span class="muted">${esc(e.role || '')}</span></td>
<td class="n">${e.conversations}</td><td class="n">${e.received}</td><td class="n">${e.answered} <span class="muted">(${pct(e.answerRate)})</span></td>
<td class="n">${fmtDuration(e.medianResponseMs)}</td><td class="n">${fmtDuration(e.slowestResponseMs)}</td>
<td class="n ${e.waiting ? 'bad' : 'ok'}">${e.waiting}</td><td class="n">${fmtDuration(e.oldestWaitingMs)}</td>
<td class="n ${e.chasesReceived ? 'bad' : ''}">${e.chasesReceived}</td><td class="n">${e.resolved}</td></tr>`).join('\n')}
</tbody></table>
<h2>Conversations</h2>
<table><thead><tr><th>Subject</th><th>With</th><th>Handled by</th><th class="n">Messages</th><th class="n">Chases</th><th class="n">First response</th><th>State</th></tr></thead><tbody>
${r.threads.map((x) => `<tr><td>${esc(x.subject)}</td><td>${esc(x.with)}${x.kind === 'party' ? ' <span class="muted">(party)</span>' : ''}</td><td>${esc(x.handledBy)}</td>
<td class="n">${x.messages}</td><td class="n ${x.chases ? 'bad' : ''}">${x.chases}</td><td class="n">${fmtDuration(x.firstResponseMs)}</td>
<td class="${x.state === 'Waiting on company' ? 'bad' : x.state === 'Resolved' ? 'ok' : ''}">${esc(x.state)}</td></tr>`).join('\n')}
</tbody></table>
<p class="muted">Response times are measured on the exercise clock (scenario time). "Waiting" counts emails that nobody at the company has answered yet.</p>
</body></html>`;
}

module.exports = { compute, toHtml, fmtDuration };
