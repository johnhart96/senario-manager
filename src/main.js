'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require('electron');
const { Store } = require('./core/store');
const { Engine } = require('./core/engine');
const ai = require('./core/ai');
const mail = require('./core/mail');
const { saveSenario, loadSenario } = require('./core/senario-file');

let win;
let store;
let engine;

// Auto-save to the open .senario file: written shortly after changes settle,
// and at least every AUTOSAVE_MAX_WAIT while changes keep coming.
const AUTOSAVE_DELAY = 1500;
const AUTOSAVE_MAX_WAIT = 10000;
let autosaveTimer = null;
let autosaveFirstPending = 0;
let lastSaved = null;
let lastSaveError = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Senario Manager',
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // The UI never needs to navigate or open windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Closing the window shuts down the reply listener, so make that explicit.
  let confirmedClose = false;
  win.on('close', (e) => {
    if (confirmedClose || !engine || (!engine.running && !engine.listener)) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep running', 'Quit'],
      defaultId: 0,
      cancelId: 0,
      title: 'Quit Senario Manager?',
      message: 'Quitting stops the scenario and closes the SMTP listener on port ' + store.settings.listener.port + '.',
      detail: 'Replies from the mail server will be queued on the server until the app is running again.',
    });
    if (choice === 0) e.preventDefault();
    else confirmedClose = true;
  });
}

function wire() {
  engine.on('log', (entry) => {
    store.appendLog(entry);
    send('log', entry);
  });
  engine.on('status', (s) => send('status', s));
  engine.on('threads-changed', () => send('threads-changed'));

  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { ok: true, result: await fn(...args) };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

  handle('settings:get', () => store.settings);
  handle('settings:set', async (s) => {
    const key = (x) => JSON.stringify([x.listener, x.mail.host]);
    const before = key(store.settings);
    store.setSettings(s);
    if (key(store.settings) !== before) {
      // Listener address/port or the allowed mail server changed: rebind.
      await engine.restartListener().catch(() => {});
    }
    return store.settings;
  });
  handle('listener:restart', () => engine.restartListener());

  handle('company:get', () => store.company);
  handle('company:set', (c) => {
    if (c.operatingYear && !require('./core/clock').validYear(c.operatingYear)) {
      throw new Error('Operating year must be between 1980 and 2100.');
    }
    store.setCompany(c);
    engine.emitStatus();
    return store.company;
  });
  handle('customers:get', () => store.customers);
  handle('customers:set', (list) => {
    store.setCustomers(list);
    return store.customers;
  });
  handle('parties:get', () => store.parties);
  handle('parties:set', (list) => {
    const company = engine.companyDomains();
    const bad = list.filter((p) => company.has(String(p.email).split('@')[1]));
    if (bad.length) throw new Error(`External parties can't use the company's own domain: ${bad.map((p) => p.email).join(', ')}`);
    store.setParties(list);
    return store.parties;
  });
  handle('customers:generate', async ({ count, replace }) => {
    const c = store.company;
    if (!c.name || !c.description) throw new Error('Enter and save the company name and description first.');
    engine.log('info', `Generating ${count} customers with OpenAI…`);
    const existing = replace ? [] : store.customers;
    const fresh = await ai.generateCustomers(store.settings.openai, {
      company: { ...c, employees: engine.employees() },
      count,
      tld: store.settings.scenario.customerTld || 'local',
      guidance: store.settings.scenario.guidance,
      existing: existing.map((x) => `${x.name} (${x.organisation})`),
    });
    const companyDomains = engine.companyDomains();
    const known = new Set(existing.map((x) => x.email));
    const added = fresh.filter((x) => !known.has(x.email) && !companyDomains.has(x.email.split('@')[1]));
    store.setCustomers([...existing, ...added]);
    engine.log('info', `Added ${added.length} customers.`);
    return store.customers;
  });
  handle('net:localIps', () =>
    Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && !i.internal && i.family === 'IPv4')
      .map((i) => i.address)
  );

  handle('engine:start', () => engine.start());
  handle('engine:stop', () => engine.stop());
  handle('engine:status', () => engine.status());
  handle('engine:setPace', (pace) => engine.setPace(pace));
  handle('engine:sendNow', (customerEmail) => engine.sendNow(customerEmail));
  handle('engine:reset', () => {
    engine.resetConversations();
    send('threads-changed');
  });
  handle('log:get', () => store.data.log.slice(-500));

  handle('file:current', () => fileInfo());
  handle('file:save', () => saveToFile(false));
  handle('file:saveAs', () => saveToFile(true));
  handle('file:open', () => openFile());
  handle('file:setAutoSave', (on) => {
    store.data.appState.autoSave = !!on;
    store.save();
    if (on) autosaveNow();
    return fileInfo();
  });
  handle('file:close', () => {
    autosaveNow();
    store.data.appState.currentFile = null;
    store.save();
    updateTitle();
    return fileInfo();
  });

  handle('threads:list', () => {
    const partyEmails = new Set(store.parties.map((p) => String(p.email).toLowerCase()));
    return Object.values(store.data.threads)
      .map((t) => ({
        party: partyEmails.has(t.customer),
        id: t.id,
        subject: t.subject,
        updatedAt: t.updatedAt,
        count: t.messages.length,
        attachments: t.messages.reduce((n, m) => n + ((m.attachments && m.attachments.length) || 0), 0),
        last: (({ attachments, ...m }) => m)(t.messages[t.messages.length - 1]),
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  });
  handle('threads:get', (id) => store.data.threads[id] || null);

  handle('test:openai', () => ai.testConnection(store.settings.openai));
  handle('test:smtp', () => mail.verifySmtp(store.settings.mail));
}

const SENARIO_FILTER = [{ name: 'Senario scenario', extensions: ['senario'] }];

const fileState = () => store.data.appState;

function fileInfo() {
  const st = fileState();
  if (!st.currentFile) return null;
  return {
    path: st.currentFile,
    name: path.basename(st.currentFile),
    includesCredentials: st.includeSecrets,
    autoSave: st.autoSave,
    lastSaved,
    error: lastSaveError,
  };
}

function updateTitle() {
  const f = fileState().currentFile;
  if (win && !win.isDestroyed()) win.setTitle(f ? `${path.basename(f)} — Senario Manager` : 'Senario Manager');
}

function writeFile(file, includeSecrets) {
  store.flush();
  saveSenario(file, store.data, { includeSecrets, appVersion: app.getVersion() });
  lastSaved = new Date().toISOString();
  lastSaveError = null;
}

// Called (via store.onChange) on every state change.
function scheduleAutosave() {
  const st = fileState();
  if (!st.currentFile || !st.autoSave) return;
  const now = Date.now();
  if (!autosaveFirstPending) autosaveFirstPending = now;
  clearTimeout(autosaveTimer);
  const wait = Math.min(AUTOSAVE_DELAY, Math.max(0, autosaveFirstPending + AUTOSAVE_MAX_WAIT - now));
  autosaveTimer = setTimeout(autosaveNow, wait);
}

function autosaveNow() {
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  autosaveFirstPending = 0;
  const st = fileState();
  if (!st.currentFile || !st.autoSave) return;
  try {
    writeFile(st.currentFile, st.includeSecrets);
  } catch (e) {
    // Report each distinct failure once (e.g. drive removed), keep retrying on later changes.
    if (lastSaveError !== e.message) {
      lastSaveError = e.message;
      engine.log('error', `Auto-save to ${st.currentFile} failed: ${e.message}`);
    }
  }
  send('file-status', fileInfo());
}

async function saveToFile(saveAs) {
  const st = fileState();
  let file = st.currentFile;
  let includeSecrets = st.includeSecrets;
  if (saveAs || !file) {
    const suggested = (store.company.name || 'scenario').replace(/[^\w\- ]+/g, '').trim() || 'scenario';
    const res = await dialog.showSaveDialog(win, {
      title: 'Save scenario',
      defaultPath: file || path.join(app.getPath('documents'), `${suggested}.senario`),
      filters: SENARIO_FILTER,
    });
    if (res.canceled || !res.filePath) return null;
    file = res.filePath.endsWith('.senario') ? res.filePath : `${res.filePath}.senario`;
    const choice = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Save without credentials', 'Include credentials'],
      defaultId: 0,
      cancelId: 0,
      title: 'Credentials',
      message: 'Include the OpenAI API key and SMTP password in the file?',
      detail: 'Leave them out if you will share this file. When a file without credentials is opened, the credentials already in the app are kept.',
    });
    includeSecrets = choice.response === 1;
  }
  clearTimeout(autosaveTimer);
  writeFile(file, includeSecrets);
  st.currentFile = file;
  st.includeSecrets = includeSecrets;
  updateTitle();
  engine.log('info', `Scenario saved to ${file}${includeSecrets ? ' (with credentials)' : ''}${st.autoSave ? '; auto-saving from now on' : ''}`);
  return fileInfo();
}

async function openFile() {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open scenario',
    defaultPath: fileState().currentFile ? path.dirname(fileState().currentFile) : app.getPath('documents'),
    filters: SENARIO_FILTER,
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return openFilePath(res.filePaths[0]);
}

// Opens a .senario file chosen in the dialog, double-clicked, or dropped on the app icon.
async function openFilePath(file) {
  if (fileState().currentFile && path.resolve(file) === path.resolve(fileState().currentFile)) return fileInfo();
  const loaded = loadSenario(file); // validates before anything is replaced

  const hasContent = store.company.name || store.customers.length || store.parties.length || Object.keys(store.data.threads).length;
  if (hasContent) {
    const choice = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Open'],
      defaultId: 1,
      cancelId: 0,
      title: 'Open scenario',
      message: `Replace the current scenario with ${path.basename(file)}?`,
      detail: (engine.running ? 'The running scenario will be stopped. ' : '') + 'Anything not saved to a .senario file will be lost.',
    });
    if (choice.response !== 1) return null;
  }

  // Finish any pending write to the previous file before switching.
  autosaveNow();
  await engine.loadSnapshot(loaded.data, { keepCredentials: !loaded.includesCredentials });
  fileState().currentFile = file;
  fileState().includeSecrets = loaded.includesCredentials;
  lastSaved = null;
  lastSaveError = null;
  updateTitle();
  const d = loaded.data;
  engine.log('info', `Opened ${path.basename(file)}: ${d.company.employees.length} employees, ${d.customers.length} customers, ${d.parties.length} external parties, ${Object.keys(d.threads).length} conversations, ${d.pending.length} scheduled jobs` +
    (loaded.includesCredentials ? '' : ' (kept existing credentials)'));
  send('state-loaded');
  send('file-status', fileInfo());
  return fileInfo();
}

// A .senario path among command-line arguments (Windows/Linux file associations).
function senarioArg(argv) {
  return argv.find((a) => /\.senario$/i.test(a) && fs.existsSync(a)) || null;
}

async function openFromOs(file) {
  if (!file) return;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  try {
    await openFilePath(file);
  } catch (e) {
    dialog.showErrorBox('Could not open scenario', e.message);
  }
}

// Keep the same data folder for development runs and installed builds (the packaged
// app's product name would otherwise move it), unless --user-data-dir is given.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'senario-manager'));
}

// One instance only: a second copy would fight over the SMTP port. Files opened
// while running are handed to the existing window.
let pendingOpen = senarioArg(process.argv.slice(1));
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => openFromOs(senarioArg(argv.slice(1))));
}
// macOS delivers double-clicked files through this event, possibly before ready.
app.on('open-file', (e, file) => {
  e.preventDefault();
  if (store && win) openFromOs(file);
  else pendingOpen = file;
});

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return;
  store = new Store(app.getPath('userData'), safeStorage);
  engine = new Engine(store);
  store.onChange = scheduleAutosave;
  wire();
  createWindow();
  updateTitle();
  // Start listening for replies straight away; errors are shown in the UI.
  if (store.settings.mail.host) engine.openListener().catch(() => {});
  if (pendingOpen) win.webContents.once('did-finish-load', () => openFromOs(pendingOpen));
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (engine) await engine.shutdown().catch(() => {});
  if (store) {
    autosaveNow();
    store.flush();
  }
  app.quit();
});

app.on('before-quit', () => {
  if (!store) return;
  if (autosaveTimer) autosaveNow();
  store.flush();
});
