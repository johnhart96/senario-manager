'use strict';

// Outbox tab: drafts held for review, and writing an email yourself.

let outbox = [];

const KIND_LABEL = { new: 'New email', reply: 'Reply', followup: 'Chase', inject: 'Inject', manual: 'Manual' };

function contactsList() {
  return [
    ...customers.map((c) => ({ ...c, kind: 'customer' })),
    ...parties.map((p) => ({ ...p, kind: 'party' })),
  ].filter((c) => c.email);
}

const nameOf = (email) => {
  const e = String(email).toLowerCase();
  const p = [...(company.employees || []), ...contactsList()].find((x) => String(x.email).toLowerCase() === e);
  return p ? p.name : email;
};

function draftHtml(d) {
  const from = contactsList().find((c) => c.email === d.sender);
  const doc = d.document ? `${d.document.title || 'Document'}${d.document.reference ? ` ${d.document.reference}` : ''} (${d.document.format || 'pdf'})` : '';
  return `<div class="draft" data-id="${esc(d.id)}">
    <div class="draft-head">
      <span class="tag">${esc(KIND_LABEL[d.kind] || d.kind)}</span>
      <b>${esc(from ? from.name : d.sender)}</b><span class="muted">${from && from.organisation ? ` · ${esc(from.organisation)}` : ''}</span>
      <span class="grow"></span>
      <span class="muted small">${esc(new Date(d.createdAt).toLocaleTimeString())}</span>
    </div>
    <div class="grid2">
      <div><label>To</label><input data-d="to" value="${esc((d.to || []).join(', '))}" /></div>
      <div><label>Cc</label><input data-d="cc" value="${esc((d.cc || []).join(', '))}" /></div>
    </div>
    <label>Subject</label><input data-d="subject" value="${esc(d.subject)}" />
    <label>Message</label><textarea data-d="body" rows="${Math.min(14, Math.max(5, (d.body || '').split('\n').length + 1))}">${esc(d.body)}</textarea>
    ${doc ? `<label class="check"><input type="checkbox" data-d="keepDocument" checked /> Attach ${esc(doc)}</label>` : ''}
    ${d.forms && d.forms.length ? `<label class="check"><input type="checkbox" data-d="keepForms" checked /> Attach the completed form${d.forms.length > 1 ? 's' : ''} (${d.forms.map((f) => `${Object.keys(f.answers).length} answers`).join(', ')})</label>` : ''}
    ${d.meeting ? `<label class="check"><input type="checkbox" data-d="keepMeeting" checked /> Include meeting invitation: ${esc(d.meeting.title)} (${esc(d.meeting.start)})</label>` : ''}
    ${d.error ? `<div class="draft-error">Last attempt failed: ${esc(d.error)}</div>` : ''}
    <div class="row">
      <span class="muted small">${d.followUp ? 'Will be chased if unanswered.' : ''}</span>
      <span class="grow"></span>
      <button data-act="discard" class="danger">Discard</button>
      <button data-act="send" class="primary">Send</button>
    </div>
  </div>`;
}

async function loadOutbox() {
  outbox = await window.api.outbox();
  $('#outboxCount').textContent = outbox.length;
  $('#drafts').innerHTML = outbox.map(draftHtml).join('') ||
    `<p class="muted">${settings && settings.scenario.reviewBeforeSend
      ? 'Nothing waiting. AI-written emails will appear here before they are sent.'
      : 'Review is off, so AI-written emails are sent straight away.'}</p>`;
  $('#reviewToggle').checked = !!(settings && settings.scenario.reviewBeforeSend);
}

const splitAddrs = (v) => v.split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

$('#drafts').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.draft');
  const id = card.dataset.id;
  if (btn.dataset.act === 'discard') {
    busy(btn, () => window.api.discardDraft(id));
    return;
  }
  const get = (k) => card.querySelector(`[data-d="${k}"]`);
  const edits = {
    to: splitAddrs(get('to').value),
    cc: splitAddrs(get('cc').value),
    subject: get('subject').value,
    body: get('body').value,
    dropDocument: get('keepDocument') ? !get('keepDocument').checked : false,
    dropMeeting: get('keepMeeting') ? !get('keepMeeting').checked : false,
    dropForms: get('keepForms') ? !get('keepForms').checked : false,
  };
  busy(btn, async () => {
    await window.api.approveDraft(id, edits);
    toast('Sent');
  });
});

$('#reviewToggle').addEventListener('change', async (e) => {
  try {
    settings = await window.api.setSettings({ ...readSettings(), scenario: { ...readSettings().scenario, reviewBeforeSend: e.target.checked } });
    fillSettings();
    toast(e.target.checked ? 'AI-written emails will wait here for review' : 'Review off: emails are sent straight away');
    loadOutbox();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- write an email ----------

function checkList(container, people, name) {
  container.innerHTML = people.map((p) => `<label class="check"><input type="checkbox" name="${name}" value="${esc(p.email)}" /> ${esc(p.name || p.email)}<span class="muted small"> ${esc(p.role || '')}</span></label>`).join('') ||
    '<span class="muted small">Add employees on the Company tab first.</span>';
}

async function fillComposeOptions() {
  const from = $('#composeFrom');
  const keep = from.value;
  const list = contactsList();
  from.innerHTML = list.length
    ? list.map((c) => `<option value="${esc(c.email)}">${esc(c.name)} (${esc(c.organisation || c.kind)})${c.kind === 'party' ? ' – party' : ''}</option>`).join('')
    : '<option value="">Add customers or parties first</option>';
  if (keep) from.value = keep;
  const staff = (company.employees || []).filter((e) => e.email);
  checkList($('#composeTo'), staff, 'to');
  // Cc: other staff plus the sender's colleagues.
  checkList($('#composeCc'), [...staff, ...list], 'cc');
  await fillComposeThreads();
}

async function fillComposeThreads() {
  const sel = $('#composeThread');
  const keep = sel.value;
  const from = $('#composeFrom').value;
  const threads = (await window.api.listThreads()).filter((t) => !t.background);
  // Conversations with this sender first.
  threads.sort((a, b) => (b.last && b.last.from === from) - (a.last && a.last.from === from));
  sel.innerHTML = '<option value="">New conversation</option>' +
    threads.slice(0, 60).map((t) => `<option value="${esc(t.id)}">Re: ${esc(t.subject)}</option>`).join('');
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

$('#composeFrom').addEventListener('change', fillComposeThreads);
$('#composeCard').addEventListener('toggle', () => { if ($('#composeCard').open) fillComposeOptions(); });

$('#composeSend').addEventListener('click', (e) => {
  const checked = (name) => $$(`input[name="${name}"]:checked`).map((i) => i.value);
  const payload = {
    from: $('#composeFrom').value,
    to: checked('to'),
    cc: checked('cc').filter((x) => x !== $('#composeFrom').value),
    threadId: $('#composeThread').value || undefined,
    subject: $('#composeSubject').value.trim(),
    body: $('#composeBody').value,
    expectReply: $('#composeExpect').checked,
  };
  if (!payload.to.length) return toast('Choose at least one recipient', true);
  busy(e.target, async () => {
    await window.api.composeSend(payload);
    $('#composeSubject').value = '';
    $('#composeBody').value = '';
    $$('#composeTo input, #composeCc input').forEach((i) => (i.checked = false));
    toast(`Sent as ${nameOf(payload.from)}`);
    fillComposeThreads();
  });
});

tabHooks.outbox = () => { loadOutbox(); if ($('#composeCard').open) fillComposeOptions(); };
