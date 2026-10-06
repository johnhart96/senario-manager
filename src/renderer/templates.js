'use strict';

// "New" button: start a scenario from a ready-made template or blank.

async function openTemplates() {
  const list = await window.api.listTemplates();
  const card = (t) => `<div class="template">
    <div class="tname">${esc(t.name)}${t.year ? ` <span class="pill">${t.year}</span>` : ''}</div>
    <div class="muted small">${esc(t.summary)}</div>
    <div class="muted small tmeta">${t.employees} staff · ${t.customers} customers · ${t.parties} parties · ${t.injects} injects</div>
    <button class="primary" data-template="${esc(t.id)}">Use this</button>
  </div>`;
  $('#templateList').innerHTML = list.map(card).join('') + `<div class="template blank">
    <div class="tname">Blank scenario</div>
    <div class="muted small">An empty company to fill in yourself.</div>
    <div class="tmeta"></div>
    <button data-template="blank">Start blank</button>
  </div>`;
  $('#modal').hidden = false;
}

$('#newScenario').addEventListener('click', (e) => busy(e.target, openTemplates));
$('#closeModal').addEventListener('click', () => ($('#modal').hidden = true));
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') $('#modal').hidden = true;
  const b = e.target.closest('[data-template]');
  if (!b) return;
  busy(b, async () => {
    const done = await window.api.loadTemplate(b.dataset.template);
    if (!done) return;
    $('#modal').hidden = true;
    showTab('company');
    toast(b.dataset.template === 'blank' ? 'Blank scenario ready' : 'Scenario ready: review it, then click Save to keep it');
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden) $('#modal').hidden = true;
});
