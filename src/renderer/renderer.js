'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let settings = null;
let company = null;
let customers = [];
let parties = [];
let running = false;
let currentThread = null;
let localIps = [];
let clockOffsetMs = 0;
let lastStatus = {};
const statusHooks = [];
const tabHooks = {};

// Real time → the company's operating year (whole-week shift, same wall-clock time).
function toScenario(d) {
  const real = new Date(d);
  if (!clockOffsetMs) return real;
  const t = new Date(real.getTime() - clockOffsetMs);
  return new Date(t.getTime() + (t.getTimezoneOffset() - real.getTimezoneOffset()) * 60000);
}

// Offset for an arbitrary year, mirroring core/clock.js (used for the live preview).
function offsetFor(year) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1980 || y > 2100) return 0;
  const now = new Date();
  const WEEK = 7 * 86400000;
  let w = Math.round(((now.getFullYear() - y) * 365.2425) / 7);
  while (new Date(now - w * WEEK).getFullYear() < y) w--;
  while (new Date(now - w * WEEK).getFullYear() > y) w++;
  return w * WEEK;
}

function renderScenarioDate() {
  const el = $('#scenarioDate');
  el.hidden = !clockOffsetMs;
  if (clockOffsetMs) el.textContent = toScenario(new Date()).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
setInterval(renderScenarioDate, 30000);

function renderYearHint() {
  const y = $('#operatingYear').value.trim();
  const off = offsetFor(y);
  $('#datedEmails').disabled = !off;
  if (y && !off && Number(y) !== new Date().getFullYear()) {
    $('#yearHint').textContent = 'Enter a year between 1980 and 2100.';
    return;
  }
  const saved = clockOffsetMs;
  clockOffsetMs = off;
  const today = toScenario(new Date()).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  clockOffsetMs = saved;
  $('#yearHint').textContent = off ? `Today in the scenario: ${today}` : 'Running in the present day.';
}
$('#operatingYear').addEventListener('input', renderYearHint);

// ---------- utilities ----------

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), isError ? 6000 : 3000);
}

async function busy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    button.disabled = false;
    // Only restore if nothing (e.g. a status update) relabelled the button meanwhile.
    if (button.textContent === 'Working…') button.textContent = label;
  }
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => (o[k] = o[k] || {}), obj)[last] = value;
}

// ---------- navigation ----------

$$('.nav').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.nav').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'threads') loadThreads();
    if (tabHooks[b.dataset.tab]) tabHooks[b.dataset.tab]();
  })
);

function showTab(name) {
  $(`.nav[data-tab="${name}"]`).click();
}

// ---------- settings ----------

function fillSettings() {
  for (const el of $$('[data-k]')) {
    const v = getPath(settings, el.dataset.k);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.dataset.type === 'list') el.value = (v || []).join(', ');
    else el.value = v ?? '';
  }
  updateAuthVisibility();
  renderRouting();
  renderPace(settings.scenario.pace || 1);
}

function readSettings() {
  const s = JSON.parse(JSON.stringify(settings));
  for (const el of $$('[data-k]')) {
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.dataset.type === 'list') v = el.value.split(',').map((x) => x.trim()).filter(Boolean);
    else if (el.type === 'number') v = el.value === '' ? 0 : Number(el.value);
    else v = el.value.trim();
    setPath(s, el.dataset.k, v);
  }
  return s;
}

function updateAuthVisibility() {
  $('#authFields').style.display = $('#smtpAuth').checked ? '' : 'none';
}
$('#smtpAuth').addEventListener('change', updateAuthVisibility);

function renderRouting() {
  const domains = [...new Set([...customers, ...parties].map((c) => c.email.split('@')[1]).filter(Boolean))];
  const target = `${localIps[0] || '<this machine>'}:${settings.listener.port}`;
  $('#routingInfo').textContent = domains.length
    ? domains.map((d) => `${d}  →  ${target}`).join('\n') + (localIps.length > 1 ? `\n\n(this machine's addresses: ${localIps.join(', ')})` : '')
    : 'Add customers or external parties first to see their domains.';
}

async function saveSettings() {
  settings = await window.api.setSettings(readSettings());
  fillSettings();
}

$('#saveSettings').addEventListener('click', (e) =>
  busy(e.target, async () => {
    await saveSettings();
    toast('Settings saved');
  })
);

$('#showDkim').addEventListener('click', (e) =>
  busy(e.target, async () => {
    const recs = await window.api.dkimRecords();
    const box = $('#dkimRecords');
    box.hidden = false;
    box.textContent = recs.length
      ? recs.map((r) => `${r.name}  TXT  "${r.value}"`).join('\n\n')
      : 'Add customers or parties first.';
  })
);

$('#backgroundNow').addEventListener('click', (e) =>
  busy(e.target, async () => {
    await saveSettings();
    await window.api.backgroundNow();
    toast('Background email sent');
  })
);

$$('[data-test]').forEach((b) =>
  b.addEventListener('click', () =>
    busy(b, async () => {
      await saveSettings();
      if (b.dataset.test === 'openai') await window.api.testOpenAI();
      if (b.dataset.test === 'smtp') await window.api.testSmtp();
      toast(`${b.dataset.test === 'smtp' ? 'SMTP' : 'OpenAI'} connection OK`);
    })
  )
);

// ---------- company ----------

function employeeRow(e = {}) {
  return `<div class="emp-row">
    <input data-f="name" value="${esc(e.name)}" placeholder="Jane Doe" />
    <input data-f="email" value="${esc(e.email)}" placeholder="jane.doe@${esc($('#companyDomain').value || 'companyx.local')}" />
    <input data-f="role" value="${esc(e.role)}" placeholder="Accounts Manager" />
    <input data-f="responsibilities" value="${esc(e.responsibilities)}" placeholder="Invoices, payments, credit accounts" />
    <button class="link" data-remove-row title="Remove">✕</button>
  </div>`;
}

function fillCompany() {
  $('#companyName').value = company.name || '';
  $('#companyDomain').value = company.domain || '';
  $('#description').value = company.description || '';
  $('#operatingYear').value = company.operatingYear || '';
  $('#datedEmails').checked = company.datedEmails !== false;
  renderYearHint();
  $('#employees').innerHTML = (company.employees || []).map(employeeRow).join('');
  $('#empCount').textContent = (company.employees || []).length;
}

function readCompany() {
  const employees = $$('#employees .emp-row')
    .map((row) => {
      const e = {};
      $$('[data-f]', row).forEach((i) => (e[i.dataset.f] = i.value.trim()));
      e.email = e.email.toLowerCase();
      return e;
    })
    .filter((e) => e.email.includes('@') && !e.email.startsWith('@'));
  return {
    name: $('#companyName').value.trim(),
    domain: $('#companyDomain').value.trim().toLowerCase(),
    description: $('#description').value.trim(),
    operatingYear: Number($('#operatingYear').value) || null,
    datedEmails: $('#datedEmails').checked,
    employees,
  };
}

$('#addEmployee').addEventListener('click', () => {
  $('#employees').insertAdjacentHTML('beforeend', employeeRow());
  $('#employees').lastElementChild.querySelector('input').focus();
});

$('#saveCompany').addEventListener('click', (e) =>
  busy(e.target, async () => {
    const c = readCompany();
    const bad = c.employees.filter((x) => c.domain && !x.email.endsWith('@' + c.domain));
    if (bad.length && !confirm(`These addresses are not on ${c.domain}:\n${bad.map((x) => x.email).join('\n')}\n\nSave anyway?`)) return;
    company = await window.api.setCompany(c);
    fillCompany();
    setStatus(await window.api.status());
    toast('Company saved');
  })
);

// ---------- customers ----------

const CUSTOMER_FIELDS = [
  ['name', 'Name'],
  ['email', 'Email'],
  ['organisation', 'Organisation'],
  ['role', 'Job title'],
  ['relationship', 'Relationship to the company', 'area'],
  ['personality', 'Personality', 'area'],
  ['writingStyle', 'Writing style', 'area'],
  ['signature', 'Signature', 'area'],
  ['memory', 'Remembers about the company (one note per line, added to automatically)', 'lines'],
];

// Expandable card for an external person (customer or party). fields: [key, label, type?, placeholder?]
function personCard(fields, c, newLabel) {
  const body = fields.map(([k, label, type, ph]) => {
    const v = esc(type === 'lines' ? (c[k] || []).join('\n') : c[k] || '');
    const p = ph ? ` placeholder="${esc(ph)}"` : '';
    const input = type === 'area' || type === 'lines'
      ? `<textarea data-f="${k}"${type === 'lines' ? ' data-type="lines"' : ''} rows="${k === 'signature' || k === 'memory' ? 4 : 2}"${p}>${v}</textarea>`
      : `<input data-f="${k}" value="${v}"${p} />`;
    return `<div class="${['signature', 'services', 'memory'].includes(k) ? 'full' : ''}"><label>${label}</label>${input}</div>`;
  }).join('');
  return `<details class="person">
    <summary>
      <span class="who">${esc(c.name || newLabel)}</span>
      <span class="sub">${esc(c.email || '')}</span>
      <span class="sub">${esc([c.role, c.organisation].filter(Boolean).join(' · '))}</span>
      <button class="link" data-remove title="Remove">✕</button>
    </summary>
    <div class="body grid2">${body}</div>
  </details>`;
}

const customerHtml = (c) => personCard(CUSTOMER_FIELDS, c, 'New customer');

function readCards(container) {
  return $$('.person', container)
    .map((el) => {
      const c = {};
      $$('[data-f]', el).forEach((i) => {
        c[i.dataset.f] = i.dataset.type === 'lines' ? i.value.split('\n').map((l) => l.trim()).filter(Boolean) : i.value.trim();
      });
      c.email = (c.email || '').toLowerCase();
      return c;
    })
    .filter((c) => c.email.includes('@'));
}

function fillCustomers() {
  $('#customers').innerHTML = customers.map(customerHtml).join('') ||
    '<p class="muted">No customers yet. Save your company, then generate some.</p>';
  $('#custCount').textContent = customers.length;
  fillSendFrom();
  if (settings) renderRouting();
  if (typeof fillComposeOptions === 'function') fillComposeOptions();
}

// "Send an email now": a random customer, a chosen customer, or a chosen party.
function fillSendFrom() {
  const chosen = $('#sendFrom').value;
  const opts = (list) => list.map((c) => `<option value="${esc(c.email)}">${esc(c.name)} (${esc(c.organisation || c.role)})</option>`).join('');
  $('#sendFrom').innerHTML = '<option value="">Random customer</option>' +
    (customers.length ? `<optgroup label="Customers">${opts(customers)}</optgroup>` : '') +
    (parties.length ? `<optgroup label="External parties">${opts(parties)}</optgroup>` : '');
  $('#sendFrom').value = chosen;
  if ($('#sendFrom').value !== chosen) $('#sendFrom').value = '';
}

const readCustomers = () => readCards($('#customers'));

document.addEventListener('click', (e) => {
  const rm = e.target.closest('[data-remove], [data-remove-row]');
  if (!rm) return;
  e.preventDefault();
  rm.closest('.person, .emp-row').remove();
});

$('#addCustomer').addEventListener('click', () => {
  if (!customers.length && !$$('#customers .person').length) $('#customers').innerHTML = '';
  $('#customers').insertAdjacentHTML('beforeend', customerHtml({}));
  $('#customers').lastElementChild.open = true;
});

async function generate(button, replace) {
  if (replace && customers.length && !confirm('Replace all existing customers with newly generated ones?')) return;
  await busy(button, async () => {
    customers = await window.api.generateCustomers({ count: Number($('#customerCount').value) || 5, replace, perOrg: Number($('#perOrg').value) || 1 });
    fillCustomers();
    toast(`${customers.length} customers`);
  });
}
$('#generateCustomers').addEventListener('click', (e) => generate(e.target, false));
$('#replaceCustomers').addEventListener('click', (e) => generate(e.target, true));

$('#saveCustomers').addEventListener('click', (e) =>
  busy(e.target, async () => {
    customers = await window.api.setCustomers(readCustomers());
    fillCustomers();
    toast('Customers saved');
  })
);

// ---------- external parties ----------

const PARTY_FIELDS = [
  ['name', 'Name', '', 'Dave Smith'],
  ['email', 'Email', '', 'dave@smithaccountants.local'],
  ['organisation', 'Organisation', '', 'Smith & Co Chartered Accountants'],
  ['role', 'Role', '', 'Accountant'],
  ['services', 'What they do for the company', 'area', 'Year-end accounts, VAT returns and payroll. Has looked after the company since 1998.'],
  ['personality', 'Personality', 'area', 'Methodical and friendly, a stickler for deadlines'],
  ['writingStyle', 'Writing style', 'area', 'Short, polite emails; uses bullet points for figures'],
  ['signature', 'Signature', 'area', 'Dave Smith ACA\nSmith & Co Chartered Accountants\nTel 0161 555 0199'],
  ['memory', 'Remembers about the company (one note per line, added to automatically)', 'lines'],
];
const partyHtml = (p) => personCard(PARTY_FIELDS, p, 'New party');

function fillParties() {
  $('#parties').innerHTML = parties.map(partyHtml).join('') ||
    '<p class="muted">No external parties yet. Add the suppliers and contractors your employees deal with.</p>';
  $('#partyCount').textContent = parties.length;
  fillSendFrom();
  if (settings) renderRouting();
}

const readParties = () => readCards($('#parties'));

$('#addParty').addEventListener('click', () => {
  if (!$$('#parties .person').length) $('#parties').innerHTML = '';
  $('#parties').insertAdjacentHTML('beforeend', partyHtml({}));
  const card = $('#parties').lastElementChild;
  card.open = true;
  card.querySelector('input').focus();
});

$('#saveParties').addEventListener('click', (e) =>
  busy(e.target, async () => {
    parties = await window.api.setParties(readParties());
    fillParties();
    toast('External parties saved');
  })
);

// ---------- .senario files ----------

function showFile(info) {
  const el = $('#fileName');
  el.textContent = info ? info.name : 'Unsaved scenario';
  el.title = info ? info.path + (info.includesCredentials ? ' (includes credentials)' : '') : '';
  el.classList.toggle('open', !!info);
  $('#closeFile').hidden = !info;
  $('#fileMeta').hidden = !info;
  if (!info) return;
  $('#autoSave').checked = info.autoSave;
  const st = $('#fileStatus');
  st.classList.toggle('err', !!info.error);
  if (info.error) {
    st.textContent = 'Save failed';
    st.title = info.error;
  } else {
    st.textContent = !info.autoSave ? 'Off' : info.lastSaved ? 'Saved ' + new Date(info.lastSaved).toLocaleTimeString() : 'On';
    st.title = '';
  }
}

$('#autoSave').addEventListener('change', async (e) => {
  showFile(await window.api.setAutoSave(e.target.checked));
});
$('#closeFile').addEventListener('click', async () => {
  showFile(await window.api.closeFile());
  toast('File closed. The scenario stays loaded but is no longer saved to that file.');
});

// Persist whatever is currently in the forms so the file matches what's on screen.
async function commitForms() {
  settings = await window.api.setSettings(readSettings());
  company = await window.api.setCompany(readCompany());
  customers = await window.api.setCustomers(readCustomers());
  parties = await window.api.setParties(readParties());
  if (typeof readInjects === 'function') injects = await window.api.setInjects(readInjects());
}

async function reloadAll() {
  [settings, company, customers, parties] = await Promise.all([window.api.getSettings(), window.api.getCompany(), window.api.getCustomers(), window.api.getParties()]);
  fillSettings();
  fillCompany();
  fillCustomers();
  fillParties();
  if (typeof loadInjects === 'function') await loadInjects();
  if (typeof loadOutbox === 'function') await loadOutbox();
  $('#log').innerHTML = '';
  (await window.api.getLog()).forEach(appendLog);
  currentThread = null;
  $('#threadView').innerHTML = '<p class="muted center">Select a conversation</p>';
  loadThreads();
  setStatus(await window.api.status());
}

async function saveFile(button, as) {
  await busy(button, async () => {
    await commitForms();
    const info = await (as ? window.api.saveFileAs() : window.api.saveFile());
    if (info) {
      showFile(info);
      toast(`Saved ${info.name}`);
    }
  });
}

async function openFile(button) {
  await busy(button, async () => {
    const info = await window.api.openFile();
    if (info) {
      showFile(info);
      toast(`Opened ${info.name}`);
    }
  });
}

$('#saveFile').addEventListener('click', (e) => saveFile(e.target, false));
$('#saveFileAs').addEventListener('click', (e) => saveFile(e.target, true));
$('#openFile').addEventListener('click', (e) => openFile(e.target));

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 's') {
    e.preventDefault();
    saveFile($(e.shiftKey ? '#saveFileAs' : '#saveFile'), e.shiftKey);
  } else if (k === 'o') {
    e.preventDefault();
    openFile($('#openFile'));
  } else if (k === 'n') {
    e.preventDefault();
    $('#newScenario').click();
  }
});

// ---------- pace ----------

const PACE_STEPS = [1, 2, 5, 10, 30, 60, 120, 360];

function fmtSpan(ms) {
  const s = ms / 1000;
  if (s < 90) return `${Math.max(1, Math.round(s))} sec`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${+(s / 3600).toFixed(1)} h`;
}

function renderPace(pace) {
  const idx = PACE_STEPS.reduce((best, v, i) => (Math.abs(v - pace) < Math.abs(PACE_STEPS[best] - pace) ? i : best), 0);
  $('#paceSlider').value = idx;
  const p = PACE_STEPS[idx];
  $('#paceValue').textContent = p === 1 ? 'Real time' : `${p}× faster`;
  if (!settings) return;
  const sc = settings.scenario;
  const span = (a, b) => (fmtSpan(a / p) === fmtSpan(b / p) ? fmtSpan(a / p) : `${fmtSpan(a / p)}–${fmtSpan(b / p)}`);
  $('#paceHint').textContent =
    `New email every ${span(sc.minIntervalMin * 60000, sc.maxIntervalMin * 60000)}, ` +
    `replies in ${span(sc.replyDelayMinSec * 1000, sc.replyDelayMaxSec * 1000)}` +
    (sc.followUpEnabled ? `, chasers after ${span(sc.followUpMinHours * 3600000, sc.followUpMaxHours * 3600000)}` : '');
}

$('#paceSlider').addEventListener('input', (e) => {
  const pace = PACE_STEPS[Number(e.target.value)];
  settings.scenario.pace = pace;
  renderPace(pace);
});
$('#paceSlider').addEventListener('change', async (e) => {
  try {
    const st = await window.api.setPace(PACE_STEPS[Number(e.target.value)]);
    settings.scenario.pace = st.pace;
    setStatus(st);
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- run / status ----------

// Exercise clock as "T+h:mm" (scenario time).
function fmtExercise(ms) {
  const min = Math.floor((ms || 0) / 60000);
  return `T+${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}

function setStatus(s) {
  running = s.running;
  clockOffsetMs = s.clockOffsetMs || 0;
  renderScenarioDate();
  $('#statusDot').classList.toggle('on', running);
  $('#statusText').textContent = running ? 'Running' : 'Stopped';
  $('#listenDot').classList.toggle('on', !!s.listening);
  $('#listenDot').classList.toggle('bad', !s.listening && !!s.listenerError);
  $('#listenText').textContent = s.listening ? 'Listening' : s.listenerError ? 'Listener failed' : 'Listener off';
  $('#listenSub').textContent = s.listening ? 'SMTP ' + s.listening : s.listenerError || 'Set the mail server in Settings';
  $('#retryListener').hidden = !!s.listening;
  const parts = [];
  if (s.exerciseMs) parts.push(fmtExercise(s.exerciseMs));
  if (running && s.nextEventAt) parts.push('next email ' + new Date(s.nextEventAt).toLocaleTimeString());
  if (s.pendingReplies) parts.push(`${s.pendingReplies} queued`);
  $('#statusSub').textContent = parts.join(' · ');
  const badge = $('#outboxBadge');
  badge.hidden = !s.outbox;
  badge.textContent = s.outbox || '';
  lastStatus = s;
  for (const fn of statusHooks) fn(s);
  const btn = $('#toggleRun');
  btn.textContent = running ? 'Stop scenario' : 'Start scenario';
  btn.classList.toggle('running', running);
}

$('#toggleRun').addEventListener('click', (e) =>
  busy(e.target, async () => {
    if (running) await window.api.stop();
    else await window.api.start();
    setStatus(await window.api.status());
  })
);

$('#retryListener').addEventListener('click', (e) =>
  busy(e.target, async () => {
    await window.api.restartListener();
    setStatus(await window.api.status());
  })
);

$('#sendNow').addEventListener('click', (e) =>
  busy(e.target, async () => {
    await window.api.sendNow($('#sendFrom').value || undefined);
    toast('Email sent');
  })
);
$('#resetConv').addEventListener('click', (e) => {
  if (!confirm('Clear all stored conversations and queued replies? Mail already delivered is not touched.')) return;
  busy(e.target, () => window.api.resetConversations());
});

function appendLog(entry) {
  const log = $('#log');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `<time>${new Date(entry.time).toLocaleTimeString()}</time><span class="lvl ${esc(entry.level)}">${esc(entry.level)}</span><span>${esc(entry.message)}</span>`;
  log.prepend(line);
  while (log.childElementCount > 500) log.lastElementChild.remove();
}

// ---------- conversations ----------

// Conversation dates are shown in the scenario's operating year.
const fmtDate = (d) => toScenario(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

async function loadThreads() {
  const showBg = $('#showBackground').checked;
  const threads = (await window.api.listThreads()).filter((t) => showBg || !t.background);
  const tags = (t) => [
    t.party ? '<span class="tag party">Party</span>' : '',
    t.background ? '<span class="tag bg">Background</span>' : '',
    t.status === 'resolved' ? '<span class="tag done">Resolved</span>' : '',
  ].join('');
  $('#threadList').innerHTML =
    threads
      .map(
        (t) => `<div class="thread-item ${t.id === currentThread ? 'active' : ''}" data-id="${esc(t.id)}">
          <div class="subj">${tags(t)}${esc(t.subject || '(no subject)')}</div>
          <div class="meta"><span>${esc(t.last ? t.last.fromName || t.last.from : '')}${t.attachments ? ` · 📎 ${t.attachments}` : ''}</span><span>${t.count} · ${fmtDate(t.updatedAt)}</span></div>
        </div>`
      )
      .join('') || '<p class="muted empty-list">No conversations yet.</p>';
  if (currentThread) showThread(currentThread);
}

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ATT_STATUS = {
  ok: 'read',
  empty: 'no readable text (scanned?)',
  unsupported: 'type not supported',
  'too-large': 'too large',
  error: 'could not be read',
};

function attachmentsHtml(list, threadId, messageId) {
  if (!list || !list.length) return '';
  return `<div class="atts">${list
    .map((a, i) => {
      const ext = (a.filename.split('.').pop() || '').slice(0, 4).toUpperCase();
      const save = a.sent && a.spec
        ? ` · <button class="link save-att" data-thread="${esc(threadId)}" data-msg="${esc(messageId)}" data-idx="${i}">Save</button>` : '';
      const head = `<span class="att-ext">${esc(ext)}</span><span class="att-name">${esc(a.filename)}</span>
        <span class="att-meta">${fmtSize(a.size)} · <span class="att-status ${esc(a.status)}" title="${esc(a.error || '')}">${esc(a.sent ? 'sent' : ATT_STATUS[a.status] || a.status)}</span>${save}</span>`;
      return a.status === 'ok' && a.text
        ? `<details class="att"><summary>${head}</summary><pre class="att-text">${esc(a.text)}${a.truncated ? '\n\n[… truncated]' : ''}</pre></details>`
        : `<div class="att">${head}</div>`;
    })
    .join('')}</div>`;
}

async function showThread(id) {
  currentThread = id;
  $$('.thread-item').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
  const t = await window.api.getThread(id);
  if (!t) return;
  $('#threadView').innerHTML =
    `<h1>${esc(t.subject)}</h1>` +
    t.messages
      .map(
        (m) => `<div class="msg ${m.direction}">
          <div class="msg-head">
            <span class="who">${esc(m.fromName || m.from)}</span>
            <span class="tag">${esc(kindLabel(m))}</span>
            <span class="addr msg-date">${fmtDate(m.date)}${typeof m.exerciseMs === 'number' ? ` · ${fmtExercise(m.exerciseMs)}` : ''}</span>
            <div class="addr">${esc(m.from)} → ${esc(m.to.join(', '))}${m.cc && m.cc.length ? ' · cc ' + esc(m.cc.join(', ')) : ''}</div>
          </div>
          ${m.meeting ? `<div class="meeting">📅 Meeting invitation: ${esc(m.meeting)}</div>` : ''}
          ${m.meetingResponse ? `<div class="meeting">📅 ${esc(m.meetingResponse)}</div>` : ''}
          <div class="msg-body">${esc(m.body)}</div>
          ${attachmentsHtml(m.attachments, t.id, m.messageId)}
        </div>`
      )
      .join('');
}

function kindLabel(m) {
  if (m.direction === 'in') return 'from company';
  return {
    reply: 'reply (AI)', followup: `chase ${m.followUp || ''} (AI)`.replace('  ', ' '), inject: 'inject', manual: 'written by you',
    ooo: 'out of office', background: 'background', new: 'new (AI)',
  }[m.kind] || 'customer (AI)';
}

$('#threadView').addEventListener('click', (e) => {
  const b = e.target.closest('.save-att');
  if (!b) return;
  e.preventDefault();
  busy(b, async () => {
    const file = await window.api.saveAttachment(b.dataset.thread, b.dataset.msg, Number(b.dataset.idx));
    if (file) toast(`Saved ${file}`);
  });
});

$('#showBackground').addEventListener('change', loadThreads);

$('#threadList').addEventListener('click', (e) => {
  const item = e.target.closest('.thread-item');
  if (item) showThread(item.dataset.id);
});

