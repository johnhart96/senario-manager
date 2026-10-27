'use strict';

// Start-up: loaded last, after every UI script has defined its functions.

window.api.on('log', appendLog);
window.api.on('status', setStatus);
window.api.on('state-loaded', reloadAll);
window.api.on('file-status', showFile);
window.api.on('threads-changed', () => {
  if ($('#tab-threads').classList.contains('active')) loadThreads();
  if ($('#tab-report').classList.contains('active')) loadReport();
});
window.api.on('outbox-changed', loadOutbox);
window.api.on('bank-changed', () => { if ($('#tab-bank').classList.contains('active')) loadBank(); });
window.api.on('injects-changed', loadInjects);
window.api.on('settings-changed', async () => {
  // An inject changed the guidance: refresh just that field, keeping other unsaved edits.
  settings = await window.api.getSettings();
  $('[data-k="scenario.guidance"]').value = settings.scenario.guidance || '';
});

(async () => {
  [settings, company, customers, parties, localIps] = await Promise.all([
    window.api.getSettings(),
    window.api.getCompany(),
    window.api.getCustomers(),
    window.api.getParties(),
    window.api.localIps(),
  ]);
  fillSettings();
  fillCompany();
  fillCustomers();
  fillParties();
  await loadInjects();
  await loadOutbox();
  setStatus(await window.api.status());
  showFile(await window.api.currentFile());
  renderUpdate(await window.api.updateStatus());
  (await window.api.getLog()).forEach(appendLog);
})();
