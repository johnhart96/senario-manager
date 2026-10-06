'use strict';

// Injects tab: the exercise timeline and its clock.

let injects = [];

const STATUS_LABEL = { pending: 'Pending', sent: 'Fired', failed: 'Failed' };

function fmtAt(min) {
  const m = Math.round(Number(min) || 0);
  return `T+${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

function injectSummary(i) {
  if (i.type === 'guidance') return `Guidance ${i.guidanceMode === 'append' ? 'added' : 'changed'}`;
  const to = (i.to || []).map(nameOf).join(', ') || 'best-placed employee';
  return `${i.from ? nameOf(i.from) : 'Random customer'} → ${to} · ${i.mode === 'exact' ? 'exact text' : 'AI from brief'}`;
}

function injectCard(i) {
  const staff = (company.employees || []).filter((e) => e.email);
  const contacts = contactsList();
  const toSet = new Set(i.to || []);
  return `<details class="person inject ${esc(i.status || 'pending')}" data-id="${esc(i.id || '')}">
    <summary>
      <span class="who"><span class="at">${fmtAt(i.at)}</span> ${esc(i.title || (i.type === 'guidance' ? 'Guidance change' : i.subject || 'Email'))}</span>
      <span class="sub">${esc(injectSummary(i))}</span>
      <span class="sub"><span class="istatus ${esc(i.status || 'pending')}" title="${esc(i.error || '')}">${esc(STATUS_LABEL[i.status] || 'Pending')}</span>${i.firedAtMs ? ` at ${fmtExercise(i.firedAtMs)}` : ''}</span>
      <span class="inject-actions">
        <button class="link" data-fire title="Fire now">Fire now</button>
        <button class="link" data-remove title="Remove">✕</button>
      </span>
    </summary>
    <div class="body">
      <div class="grid3">
        <div><label>Minutes after start</label><input data-i="at" type="number" min="0" step="1" value="${esc(i.at ?? 0)}" /></div>
        <div><label>Title</label><input data-i="title" value="${esc(i.title || '')}" placeholder="e.g. Invoice dispute" /></div>
        <div><label>Type</label><select data-i="type">
          <option value="email" ${i.type !== 'guidance' ? 'selected' : ''}>Email from a customer or party</option>
          <option value="guidance" ${i.type === 'guidance' ? 'selected' : ''}>Change the scenario guidance</option>
        </select></div>
      </div>
      <div class="only-email">
        <div class="grid2">
          <div><label>From</label><select data-i="from">
            <option value="">Random customer</option>
            ${contacts.map((c) => `<option value="${esc(c.email)}" ${c.email === i.from ? 'selected' : ''}>${esc(c.name)} (${esc(c.organisation || c.kind)})</option>`).join('')}
          </select></div>
          <div><label>Written</label><select data-i="mode">
            <option value="brief" ${i.mode !== 'exact' ? 'selected' : ''}>By the AI, from a brief</option>
            <option value="exact" ${i.mode === 'exact' ? 'selected' : ''}>Exactly as below</option>
          </select></div>
        </div>
        <label>To <span class="muted small">(none ticked: the AI picks the right person)</span></label>
        <div class="checks">${staff.map((e) => `<label class="check"><input type="checkbox" data-i-to value="${esc(e.email)}" ${toSet.has(e.email) ? 'checked' : ''} /> ${esc(e.name)}</label>`).join('')}</div>
        <div class="only-exact"><label>Subject</label><input data-i="subject" value="${esc(i.subject || '')}" /></div>
        <label class="only-brief">Brief: what the email should say</label>
        <label class="only-exact">Message</label>
        <textarea data-i="body" rows="4" placeholder="e.g. Complain that the delivery for order 4471 never arrived and ask for a refund.">${esc(i.type === 'guidance' ? '' : i.body || '')}</textarea>
        <label class="check"><input type="checkbox" data-i="expectReply" ${i.expectReply !== false ? 'checked' : ''} /> Waiting for an answer (chase if unanswered)</label>
      </div>
      <div class="only-guidance">
        <label>Guidance for every customer and party from this point</label>
        <textarea data-i="guidance" rows="3" placeholder="e.g. A product recall is under way; customers are anxious.">${esc(i.type === 'guidance' ? i.body || '' : '')}</textarea>
        <label class="check"><input type="checkbox" data-i="append" ${i.guidanceMode === 'append' ? 'checked' : ''} /> Add to the existing guidance instead of replacing it</label>
      </div>
      ${i.error ? `<div class="draft-error">Last attempt failed: ${esc(i.error)}</div>` : ''}
    </div>
  </details>`;
}

function syncInjectCard(card) {
  const type = card.querySelector('[data-i="type"]').value;
  const mode = card.querySelector('[data-i="mode"]').value;
  card.querySelectorAll('.only-email').forEach((x) => (x.hidden = type !== 'email'));
  card.querySelectorAll('.only-guidance').forEach((x) => (x.hidden = type !== 'guidance'));
  card.querySelectorAll('.only-exact').forEach((x) => (x.hidden = mode !== 'exact'));
  card.querySelectorAll('.only-brief').forEach((x) => (x.hidden = mode === 'exact'));
}

function renderInjects() {
  $('#injectCount').textContent = injects.length;
  $('#injects').innerHTML = injects.map(injectCard).join('') ||
    '<p class="muted">No injects yet. Add events that should happen at set times, e.g. a complaint 20 minutes in.</p>';
  $$('#injects .inject').forEach(syncInjectCard);
}

async function loadInjects() {
  injects = await window.api.getInjects();
  renderInjects();
}

function readInjects() {
  return $$('#injects .inject').map((card) => {
    const v = (k) => card.querySelector(`[data-i="${k}"]`);
    const type = v('type').value;
    return {
      id: card.dataset.id || undefined,
      at: Number(v('at').value) || 0,
      title: v('title').value.trim(),
      type,
      from: v('from').value,
      to: [...card.querySelectorAll('[data-i-to]:checked')].map((x) => x.value),
      mode: v('mode').value,
      subject: v('subject').value.trim(),
      body: type === 'guidance' ? v('guidance').value.trim() : v('body').value.trim(),
      expectReply: v('expectReply').checked,
      guidanceMode: v('append').checked ? 'append' : 'replace',
    };
  });
}

$('#injects').addEventListener('change', (e) => {
  const card = e.target.closest('.inject');
  if (card && e.target.matches('[data-i="type"], [data-i="mode"]')) syncInjectCard(card);
});

$('#injects').addEventListener('click', (e) => {
  const fire = e.target.closest('[data-fire]');
  if (!fire) return;
  e.preventDefault();
  busy(fire, async () => {
    // Save first, so the inject fires as currently edited. Saving re-sorts by time,
    // so find it again by id, or (if it was new) by its contents.
    const card = fire.closest('.inject');
    const mine = readInjects()[$$('#injects .inject').indexOf(card)];
    injects = await window.api.setInjects(readInjects());
    const target = injects.find((x) => mine.id && x.id === mine.id) ||
      injects.find((x) => x.at === mine.at && x.title === mine.title && x.body === mine.body && x.type === mine.type);
    renderInjects();
    if (!target) throw new Error('Could not find the inject after saving.');
    const r = await window.api.fireInject(target.id);
    if (r.status === 'failed') throw new Error(r.error);
    toast(`Fired: ${r.title || 'inject'}`);
  });
});

$('#addInject').addEventListener('click', () => {
  if (!$$('#injects .inject').length) $('#injects').innerHTML = '';
  const last = readInjects().reduce((m, i) => Math.max(m, i.at), 0);
  $('#injects').insertAdjacentHTML('beforeend', injectCard({ at: last + 15, type: 'email', mode: 'brief', expectReply: true, status: 'pending' }));
  const card = $('#injects').lastElementChild;
  syncInjectCard(card);
  card.open = true;
  card.querySelector('[data-i="title"]').focus();
});

$('#saveInjects').addEventListener('click', (e) =>
  busy(e.target, async () => {
    injects = await window.api.setInjects(readInjects());
    renderInjects();
    toast('Injects saved');
  })
);

$('#resetExercise').addEventListener('click', (e) => {
  if (!confirm('Reset the exercise clock to T+0:00 and set every inject back to pending?')) return;
  busy(e.target, () => window.api.resetExercise());
});

// The clock in the header, kept current from status updates and a local tick.
statusHooks.push((s) => {
  $('#exerciseState').textContent = s.exerciseRunning
    ? `Running · ${s.injectsPending} inject${s.injectsPending === 1 ? '' : 's'} still to come`
    : s.exerciseMs ? 'Paused: continues when the scenario is started' : 'Paused: starts with the scenario';
  $('#exerciseClock').textContent = fmtExercise(s.exerciseMs);
});
setInterval(() => {
  if (!lastStatus.exerciseRunning) return;
  const since = Date.now() - (lastStatus.receivedAt || Date.now());
  $('#exerciseClock').textContent = fmtExercise(lastStatus.exerciseMs + since * (lastStatus.pace || 1));
}, 1000);
statusHooks.push((s) => { s.receivedAt = Date.now(); });
