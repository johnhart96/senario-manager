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
  backgroundNow: () => call('engine:backgroundNow'),
  outbox: () => call('outbox:list'),
  approveDraft: (id, edits) => call('outbox:approve', id, edits),
  discardDraft: (id) => call('outbox:discard', id),
  composeSend: (payload) => call('compose:send', payload),
  getInjects: () => call('injects:get'),
  setInjects: (list) => call('injects:set', list),
  fireInject: (id) => call('injects:fire', id),
  resetExercise: () => call('exercise:reset'),
  getReport: () => call('report:get'),
  exportReport: (format) => call('report:export', format),
  listTemplates: () => call('templates:list'),
  loadTemplate: (id) => call('templates:load', id),
  dkimRecords: () => call('dkim:records'),
  saveAttachment: (threadId, messageId, idx) => call('attachment:save', threadId, messageId, idx),
  updateStatus: () => call('update:status'),
  checkForUpdate: () => call('update:check'),
  downloadUpdate: () => call('update:download'),
  installUpdate: () => call('update:install'),
  setAutoUpdate: (on) => call('update:setAuto', on),
  openReleasePage: () => call('update:openPage'),
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
  endThread: (id) => call('threads:end', id),
  bank: () => call('bank:get'),
  setBankAccount: (patch) => call('bank:setAccount', patch),
  addTransaction: (t) => call('bank:addTransaction', t),
  removeTransaction: (id) => call('bank:removeTransaction', id),
  payNow: (id) => call('bank:payNow', id),
  cancelPayment: (id) => call('bank:cancelPayment', id),
  sendStatement: (opts) => call('bank:sendStatement', opts),
  setOnlineBanking: (opts) => call('bank:setOnline', opts),
  addBankUser: (u) => call('bank:addUser', u),
  removeBankUser: (username) => call('bank:removeUser', username),
  addDirectDebit: (dd) => call('bank:addDirectDebit', dd),
  removeDirectDebit: (id) => call('bank:removeDirectDebit', id),
  openBankSite: () => call('bank:openSite'),
  removeThread: (id) => call('threads:remove', id),
  testOpenAI: () => call('test:openai'),
  testSmtp: () => call('test:smtp'),
  on: (channel, fn) => {
    const allowed = ['log', 'status', 'threads-changed', 'state-loaded', 'file-status', 'outbox-changed', 'bank-changed', 'injects-changed', 'settings-changed', 'update-status'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
