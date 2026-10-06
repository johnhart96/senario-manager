'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

contextBridge.exposeInMainWorld('api', {
  getSettings: () => call('settings:get'),
  setSettings: (s) => call('settings:set', s),
  getCompany: () => call('company:get'),
  setCompany: (c) => call('company:set', c),
  getCustomers: () => call('customers:get'),
  setCustomers: (list) => call('customers:set', list),
  generateCustomers: (opts) => call('customers:generate', opts),
  getParties: () => call('parties:get'),
  setParties: (list) => call('parties:set', list),
  localIps: () => call('net:localIps'),
  start: () => call('engine:start'),
  stop: () => call('engine:stop'),
  restartListener: () => call('listener:restart'),
  status: () => call('engine:status'),
  setPace: (pace) => call('engine:setPace', pace),
  sendNow: (customerEmail) => call('engine:sendNow', customerEmail),
  resetConversations: () => call('engine:reset'),
  getLog: () => call('log:get'),
  currentFile: () => call('file:current'),
  saveFile: () => call('file:save'),
  saveFileAs: () => call('file:saveAs'),
  openFile: () => call('file:open'),
  setAutoSave: (on) => call('file:setAutoSave', on),
  closeFile: () => call('file:close'),
  listThreads: () => call('threads:list'),
  getThread: (id) => call('threads:get', id),
  testOpenAI: () => call('test:openai'),
  testSmtp: () => call('test:smtp'),
  on: (channel, fn) => {
    const allowed = ['log', 'status', 'threads-changed', 'state-loaded', 'file-status'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
