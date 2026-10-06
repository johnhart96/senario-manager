'use strict';

// Report tab: per-employee performance and conversation outcomes.

function fmtDur(ms) {
  if (ms === null || ms === undefined) return '–';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${String(min % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
const pct = (x) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);

async function loadReport() {
  const r = await window.api.getReport();
  const t = r.totals;
  const card = (label, value, cls = '') => `<div class="stat ${cls}"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;
  $('#reportView').innerHTML = !r.employees.length
    ? '<div class="card muted">Add employees on the Company tab to see a report.</div>'
    : `<div class="stats">
      ${card('Exercise time', fmtExercise(r.exerciseMs))}
      ${card('Conversations', t.conversations)}
      ${card('Emails to staff', t.received)}
      ${card('Answered', `${t.answered} (${pct(t.received ? t.answered / t.received : null)})`)}
      ${card('Median response', fmtDur(t.medianResponseMs))}
      ${card('Still waiting', t.waiting, t.waiting ? 'bad' : 'ok')}
      ${card('Chases', t.chases, t.chases ? 'bad' : '')}
      ${card('Resolved', t.resolved, 'ok')}
    </div>
    <div class="card">
      <h2>By employee</h2>
      <table class="rtable"><thead><tr><th>Employee</th><th class="n">Conversations</th><th class="n">Emails</th><th class="n">Answered</th>
        <th class="n">Median response</th><th class="n">Slowest</th><th class="n">Waiting</th><th class="n">Oldest waiting</th><th class="n">Chases</th><th class="n">Resolved</th></tr></thead>
      <tbody>${r.employees.map((e) => `<tr>
        <td><b>${esc(e.name)}</b><div class="muted small">${esc(e.role || '')}</div></td>
        <td class="n">${e.conversations}</td><td class="n">${e.received}</td><td class="n">${e.answered} <span class="muted">${pct(e.answerRate)}</span></td>
        <td class="n">${fmtDur(e.medianResponseMs)}</td><td class="n">${fmtDur(e.slowestResponseMs)}</td>
        <td class="n ${e.waiting ? 'bad' : 'ok'}">${e.waiting}</td><td class="n">${fmtDur(e.oldestWaitingMs)}</td>
        <td class="n ${e.chasesReceived ? 'bad' : ''}">${e.chasesReceived}</td><td class="n">${e.resolved}</td></tr>`).join('')}</tbody></table>
    </div>
    <div class="card">
      <h2>Conversations</h2>
      ${r.threads.length ? `<table class="rtable"><thead><tr><th>Subject</th><th>With</th><th>Handled by</th><th class="n">Messages</th><th class="n">Chases</th><th class="n">First response</th><th>State</th></tr></thead>
      <tbody>${r.threads.map((x) => `<tr><td>${esc(x.subject)}</td><td>${esc(x.with)}${x.kind === 'party' ? ' <span class="tag party">Party</span>' : ''}</td>
        <td>${esc(x.handledBy)}</td><td class="n">${x.messages}</td><td class="n ${x.chases ? 'bad' : ''}">${x.chases}</td><td class="n">${fmtDur(x.firstResponseMs)}</td>
        <td class="${x.state === 'Waiting on company' ? 'bad' : x.state === 'Resolved' ? 'ok' : ''}">${esc(x.state)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">No conversations yet.</p>'}
      <p class="muted small">Response times are on the exercise clock (scenario time). "Waiting" counts emails nobody at the company has answered yet. Background mail is not included.</p>
    </div>`;
}

$('#refreshReport').addEventListener('click', (e) => busy(e.target, loadReport));
for (const [id, format] of [['#exportHtml', 'html'], ['#exportPdf', 'pdf']]) {
  $(id).addEventListener('click', (e) =>
    busy(e.target, async () => {
      const file = await window.api.exportReport(format);
      if (file) toast(`Saved ${file}`);
    })
  );
}

tabHooks.report = loadReport;
