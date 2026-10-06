'use strict';

// Settings → Updates card, and the sidebar banner when an update is ready.

let update = {};

const UPDATE_TEXT = {
  idle: () => 'Not checked yet.',
  checking: () => 'Checking GitHub for a new version…',
  current: (u) => `You have the latest version${u.checkedAt ? ` (checked ${new Date(u.checkedAt).toLocaleTimeString()})` : ''}.`,
  available: (u) => `Version ${u.version} is available.`,
  downloading: (u) => `Downloading version ${u.version}… ${u.progress || 0}%`,
  downloaded: (u) => `Version ${u.version} is ready. It installs when you restart the app.`,
  error: (u) => u.error || 'The update check failed.',
};

function renderUpdate(u) {
  update = u || update;
  const s = update;
  $('#appVersion').textContent = s.currentVersion || '';
  $('#updateState').textContent = s.mode === 'off' ? s.reason : (UPDATE_TEXT[s.state] || UPDATE_TEXT.idle)(s);
  $('#updateState').classList.toggle('err', s.state === 'error');
  $('#autoUpdate').checked = s.autoCheck !== false;
  $('#autoUpdate').disabled = s.mode === 'off';
  $('#checkUpdate').hidden = s.mode === 'off';
  $('#checkUpdate').disabled = s.state === 'checking' || s.state === 'downloading';
  $('#downloadUpdate').hidden = !(s.mode === 'auto' && s.state === 'available');
  $('#installUpdate').hidden = s.state !== 'downloaded';
  $('#openReleasePage').hidden = !(s.mode === 'notify' && s.state === 'available');
  $('#updateMode').textContent = s.mode === 'notify' ? s.reason
    : s.mode === 'auto' ? 'New versions download in the background and install when you restart. The app never restarts by itself.' : '';
  $('#updateNotes').hidden = !(s.notes && ['available', 'downloading', 'downloaded'].includes(s.state));
  $('#updateNotes').textContent = s.notes || '';
  const banner = $('#updateBanner');
  banner.hidden = !['available', 'downloaded'].includes(s.state);
  banner.textContent = s.state === 'downloaded' ? `Update ${s.version} ready: restart to install` : `Version ${s.version} available`;
}

$('#updateBanner').addEventListener('click', () => {
  showTab('settings');
  $('#updatesCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#checkUpdate').addEventListener('click', (e) => busy(e.target, async () => renderUpdate(await window.api.checkForUpdate())));
$('#downloadUpdate').addEventListener('click', (e) => busy(e.target, () => window.api.downloadUpdate()));
$('#openReleasePage').addEventListener('click', () => window.api.openReleasePage());
$('#installUpdate').addEventListener('click', (e) => {
  const msg = running
    ? 'The scenario will stop and the app will restart to install the update. Queued replies and the exercise clock resume when you start again. Continue?'
    : 'Restart now to install the update?';
  if (!confirm(msg)) return;
  busy(e.target, () => window.api.installUpdate());
});
$('#autoUpdate').addEventListener('change', async (e) => {
  await window.api.setAutoUpdate(e.target.checked);
  renderUpdate({ ...update, autoCheck: e.target.checked });
});

window.api.on('update-status', renderUpdate);
