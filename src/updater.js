'use strict';

// Auto-updates from GitHub Releases (electron-updater).
//
// What each install can do:
//   auto   — download in the background and install on restart: Windows installer,
//            Linux AppImage / .deb / .rpm, and signed macOS builds.
//   notify — only say a new version exists and link to the download page: the
//            Windows portable .exe and unsigned macOS builds (Apple only lets signed
//            apps replace themselves).
//   off    — development runs (npm start).
//
// Only published (not draft) releases are offered. Checks contact github.com, so
// they can be switched off, never interrupt anything, and fail quietly offline.
// SENARIO_UPDATE_FEED=<url> points the updater at a self-hosted copy of the release
// files instead (a generic HTTP server), e.g. for air-gapped labs or testing.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FIRST_CHECK_MS = 15000;
const CHECK_EVERY_MS = 6 * 3600000;

class Updater extends EventEmitter {
  constructor({ app, isEnabled, log }) {
    super();
    this.app = app;
    this.isEnabled = isEnabled;
    this.log = log;
    this.timer = null;
    this.lastLoggedError = null;
    // The project's package.json sits one level above src/ (also inside app.asar).
    let pkg = {};
    for (const file of [path.join(__dirname, '..', 'package.json'), path.join(app.getAppPath(), 'package.json')]) {
      try { pkg = JSON.parse(fs.readFileSync(file, 'utf8')); break; } catch { /* try the next location */ }
    }
    const repo = /github\.com[/:]([^/]+)\/([^/.]+)/.exec((pkg.repository && pkg.repository.url) || pkg.homepage || '');
    this.releasesUrl = repo ? `https://github.com/${repo[1]}/${repo[2]}/releases/latest` : null;
    this.status = { state: 'idle', currentVersion: pkg.version || app.getVersion(), mode: 'off', reason: '' };
  }

  // Which kind of update this install supports.
  detectMode() {
    if (!this.app.isPackaged && !process.env.SENARIO_UPDATE_FEED) return ['off', 'Development build: updates are only available in installed copies.'];
    if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_DIR) {
      return ['notify', 'The portable version cannot update itself; download the new version instead.'];
    }
    if (process.platform === 'darwin' && !this.macSigned()) {
      return ['notify', 'This copy is not code-signed, so macOS will not let it replace itself; download the new version instead.'];
    }
    if (process.platform === 'linux' && !process.env.APPIMAGE && !fs.existsSync(path.join(process.resourcesPath, 'package-type'))) {
      return ['notify', 'This copy was not installed from an AppImage, .deb or .rpm; download the new version instead.'];
    }
    return ['auto', ''];
  }

  macSigned() {
    try {
      const appPath = path.resolve(path.dirname(process.execPath), '..', '..');
      const out = execFileSync('codesign', ['-dv', '--verbose=2', appPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return /Authority=Developer ID Application/.test(out);
    } catch (e) {
      // codesign writes its details to stderr.
      return /Authority=Developer ID Application/.test(String(e.stderr || ''));
    }
  }

  init() {
    const [mode, reason] = this.detectMode();
    this.set({ mode, reason });
    if (mode === 'off') return;
    const { autoUpdater } = require('electron-updater');
    this.au = autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = mode === 'auto';
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null;
    if (process.env.SENARIO_UPDATE_FEED) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.SENARIO_UPDATE_FEED });

    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', error: null }));
    autoUpdater.on('update-not-available', () => this.set({ state: 'current', checkedAt: new Date().toISOString() }));
    autoUpdater.on('update-available', (info) => {
      this.set({ state: 'available', version: info.version, releaseDate: info.releaseDate, notes: plainNotes(info.releaseNotes), checkedAt: new Date().toISOString() });
      this.log('info', `Senario Manager ${info.version} is available (you have ${this.status.currentVersion}).`);
      // Downloads quietly in the background; installing always waits for the user.
      if (this.status.mode === 'auto' && this.isEnabled()) this.download().catch(() => {});
    });
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', progress: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => {
      this.set({ state: 'downloaded', version: info.version, progress: 100 });
      this.log('info', `Senario Manager ${info.version} has been downloaded and will be installed when you restart the app.`);
    });
    autoUpdater.on('error', (e) => {
      const msg = friendly(e);
      this.set({ state: 'error', error: msg });
      // Offline labs fail every check; log each distinct problem once, quietly.
      if (msg !== this.lastLoggedError) {
        this.lastLoggedError = msg;
        this.log('info', `Update check: ${msg}`);
      }
    });

    this.schedule();
  }

  set(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  // Background checks: shortly after start-up, then every few hours, while enabled.
  schedule() {
    clearTimeout(this.timer);
    if (!this.au) return;
    const run = () => {
      if (this.isEnabled()) this.check().catch(() => {});
      this.timer = setTimeout(run, CHECK_EVERY_MS);
      this.timer.unref();
    };
    this.timer = setTimeout(run, FIRST_CHECK_MS);
    this.timer.unref();
  }

  async check() {
    if (!this.au) throw new Error(this.status.reason || 'Updates are not available.');
    if (['downloading', 'downloaded'].includes(this.status.state)) return this.status;
    await this.au.checkForUpdates();
    return this.status;
  }

  async download() {
    if (!this.au || this.status.mode !== 'auto') throw new Error(this.status.reason || 'This copy cannot update itself.');
    if (this.status.state === 'downloaded') return this.status;
    this.set({ state: 'downloading', progress: 0 });
    await this.au.downloadUpdate();
    return this.status;
  }

  install() {
    if (!this.au || this.status.state !== 'downloaded') throw new Error('No update has been downloaded yet.');
    this.au.quitAndInstall(false, true);
  }
}

function plainNotes(notes) {
  if (!notes) return '';
  const text = Array.isArray(notes) ? notes.map((n) => n.note || '').join('\n\n') : String(notes);
  return text.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
}

function friendly(e) {
  const m = String((e && e.message) || e);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|net::ERR_/.test(m)) return 'GitHub could not be reached (offline or blocked network).';
  if (/404/.test(m) && /latest.*\.yml/.test(m)) return 'The latest release has no update information yet.';
  if (/Code signature|not signed|ShipIt/i.test(m)) return 'macOS refused to install an unsigned update; download the new version instead.';
  return m.split('\n')[0].slice(0, 300);
}

module.exports = { Updater };
