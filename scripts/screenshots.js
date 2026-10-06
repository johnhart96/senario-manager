'use strict';

// Regenerates the screenshots in docs/images from a fictional demo scenario.
// Run with: npm run screenshots
// It starts the real app against a throwaway profile, so your own data is untouched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const OUT = path.join(__dirname, '..', 'docs', 'images');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'senario-shots-'));
// The switch stops main.js pinning the real data folder; setPath points Electron at the
// throwaway profile. Both are needed so your own scenario is never read or written.
app.commandLine.appendSwitch('user-data-dir', profile);
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

const employees = [
  { name: 'Sarah Collins', email: 'sarah.collins@northwind.local', role: 'Sales Manager', responsibilities: 'Quotes, new hire enquiries, key accounts' },
  { name: 'Tom Reid', email: 'tom.reid@northwind.local', role: 'Hire Coordinator', responsibilities: 'Bookings, crew scheduling, deliveries' },
  { name: 'Priya Shah', email: 'priya.shah@northwind.local', role: 'Accounts', responsibilities: 'Invoices, payments, credit accounts' },
  { name: 'Mike Dunn', email: 'mike.dunn@northwind.local', role: 'Operations Director', responsibilities: 'Escalations, suppliers, warehouse' },
];
const customers = [
  { name: 'Helen Marsh', email: 'helen.marsh@riversidetheatre.local', organisation: 'Riverside Theatre', role: 'Production Manager', relationship: 'Hires lighting for every main-house show since 1999', personality: 'Organised, warm, but firm about budgets', writingStyle: 'Friendly, detailed, numbered points', signature: 'Helen Marsh\nProduction Manager\nRiverside Theatre\nTel 0161 496 0321' },
  { name: 'Gary Pike', email: 'gary@pikeevents.local', organisation: 'Pike Events', role: 'Director', relationship: 'Corporate events client, books a few times a year', personality: 'Impatient, always last-minute', writingStyle: 'Short, few capitals', signature: 'Gary\nPike Events' },
  { name: 'Aisha Rahman', email: 'a.rahman@stmarysschool.local', organisation: "St Mary's School", role: 'Bursar', relationship: 'Annual school play hire', personality: 'Polite and precise', writingStyle: 'Formal', signature: "Mrs A. Rahman\nBursar, St Mary's School" },
  { name: 'Jon Ellery', email: 'jon@elleryweddings.local', organisation: 'Ellery Weddings', role: 'Planner', relationship: 'New customer this year', personality: 'Chatty and enthusiastic', writingStyle: 'Long emails, lots of exclamation marks', signature: 'Jon x\nEllery Weddings' },
];
const parties = [
  { name: 'Dave Smith', email: 'dave@smithaccountants.local', organisation: 'Smith & Co Chartered Accountants', role: 'Accountant', services: 'Year-end accounts, VAT returns and payroll since 1998', personality: 'Methodical, a stickler for deadlines', writingStyle: 'Brief, bullet points for figures', signature: 'Dave Smith ACA\nSmith & Co\nTel 0161 496 0199' },
  { name: 'Kev Morgan', email: 'kev@bytefix.local', organisation: 'ByteFix IT', role: 'IT contractor', services: 'Looks after the office PCs, the server and the backups', personality: 'Laid back', writingStyle: 'Casual', signature: 'Kev\nByteFix IT\n07700 900123' },
];

const quoteText = `NORTHWIND STAGE LIGHTING LTD — QUOTATION Q-4471
Customer: Riverside Theatre    Date: 3 October 2005
Item\tQty\tDays\tRate\tTotal
Strand Cantata 18/32 profile\t24\t14\t£4.50\t£1,512.00
Strand Coda 500 flood\t12\t14\t£2.00\t£336.00
Avolites Pearl 2004 desk\t1\t14\t£45.00\t£630.00
Delivery & collection\t1\t\t£120.00\t£120.00
Subtotal £2,598.00   VAT @ 17.5% £454.65   TOTAL £3,052.65`;

const threads = {
  t1: { id: 't1', subject: 'Lighting for "An Inspector Calls"', customer: customers[0].email, updatedAt: ago(12), messages: [
    { messageId: '<a1@riversidetheatre.local>', direction: 'out', from: customers[0].email, fromName: 'Helen Marsh', to: [employees[0].email], cc: [], subject: 'Lighting for "An Inspector Calls"', date: ago(190),
      body: 'Hi Sarah,\n\nWe open "An Inspector Calls" on 20 October for a two-week run. Could you quote for:\n\n1. 24 x profiles (Cantatas if you have them)\n2. 12 x floods\n3. A desk, the Pearl if it is free\n\nGet-in is Monday 17th. Our budget is tight this season, so anything you can do on price would be appreciated.\n\nMany thanks,\nHelen Marsh\nProduction Manager\nRiverside Theatre\nTel 0161 496 0321' },
    { messageId: '<s1@northwind.local>', direction: 'in', from: employees[0].email, fromName: 'Sarah Collins', to: [customers[0].email], cc: [], subject: 'RE: Lighting for "An Inspector Calls"', date: ago(70),
      body: 'Hi Helen,\n\nLovely to hear from you. Quote attached, all kit is available for your dates.\n\nBest regards,\nSarah',
      attachments: [{ filename: 'Quote Q-4471.pdf', contentType: 'application/pdf', size: 48213, kind: 'pdf', status: 'ok', text: quoteText, truncated: false }] },
    { messageId: '<a2@riversidetheatre.local>', direction: 'out', from: customers[0].email, fromName: 'Helen Marsh', to: [employees[0].email], cc: [], subject: 'Re: Lighting for "An Inspector Calls"', date: ago(12),
      body: 'Hi Sarah,\n\nThanks for Q-4471, that all looks right for the rig. Two questions before I can get it signed off:\n\n1. The £120 delivery charge, last season it was included for a two-week hire. Has that changed?\n2. Could the Pearl come in on the Friday before so our LX can pre-plot?\n\nIf we can sort the delivery, I can fax over the order by Thursday.\n\nMany thanks,\nHelen' },
  ] },
  t2: { id: 't2', subject: 'Q3 VAT return', customer: parties[0].email, updatedAt: ago(35), messages: [
    { messageId: '<p1@northwind.local>', direction: 'in', from: employees[2].email, fromName: 'Priya Shah', to: [parties[0].email], cc: [], subject: 'Q3 VAT return', date: ago(95), body: 'Hi Dave,\n\nCan you confirm what we owe for the July–September VAT quarter and when it needs paying?\n\nThanks,\nPriya' },
    { messageId: '<d1@smithaccountants.local>', direction: 'out', from: parties[0].email, fromName: 'Dave Smith', to: [employees[2].email], cc: [], subject: 'Re: Q3 VAT return', date: ago(35), body: 'Hi Priya,\n\n- Output VAT: £18,940.12\n- Input VAT: £11,287.40\n- Payable: £7,652.72\n\nDue with the return by 7 November. Could you send me the September bank statement so I can finish the reconciliation?\n\nDave Smith ACA\nSmith & Co\nTel 0161 496 0199' },
  ] },
  t3: { id: 't3', subject: 'URGENT - smoke machine for friday', customer: customers[1].email, updatedAt: ago(4), messages: [
    { messageId: '<g1@pikeevents.local>', direction: 'out', from: customers[1].email, fromName: 'Gary Pike', to: [employees[1].email], cc: [], subject: 'URGENT - smoke machine for friday', date: ago(250), body: 'tom, need 2 smoke machines + fluid for the Midland hotel friday night. can you do it. need to know today\n\nGary\nPike Events' },
    { messageId: '<g2@pikeevents.local>', direction: 'out', from: customers[1].email, fromName: 'Gary Pike', to: [employees[1].email], cc: [employees[3].email], subject: 'Re: URGENT - smoke machine for friday', date: ago(4), body: 'tom, still waiting on this. the client is asking me and i have nothing to tell them. mike can you chase please\n\nGary' },
  ] },
};

const now = Date.now();
const seed = {
  settings: {
    openai: { model: 'gpt-4.1-mini' },
    mail: { host: '10.0.0.25', smtpPort: 25, smtpSecurity: 'starttls' },
    listener: { bindAddress: '127.0.0.1', port: 2590, offerStartTls: true },
    scenario: { customerTld: 'local', minIntervalMin: 20, maxIntervalMin: 90, replyDelayMinSec: 900, replyDelayMaxSec: 7200, pace: 30, followUpEnabled: true },
  },
  company: { name: 'Northwind Stage Lighting Ltd', domain: 'northwind.local', operatingYear: 2005, datedEmails: true,
    description: 'Northwind hires and installs stage lighting for theatres, schools, weddings and corporate events across the North West. Customers request quotes, book kit and crew, report faults and query invoices. Busy autumn season with several theatre openings.',
    employees },
  customers,
  parties,
  threads,
  msgIndex: Object.fromEntries(Object.values(threads).flatMap((t) => t.messages.map((m) => [m.messageId, t.id]))),
  pending: [
    { id: 'j1', type: 'reply', customer: customers[0].email, threadId: 't1', replyToId: '<s1@northwind.local>', due: now + 9 * 60000, scenarioMs: 3600000 },
    { id: 'j2', type: 'followup', customer: customers[1].email, threadId: 't3', afterId: '<g2@pikeevents.local>', attempt: 2, due: now + 40 * 60000, scenarioMs: 7200000 },
  ],
  log: [
    { time: ago(250), level: 'send', message: 'Gary Pike (Pike Events) → tom.reid@northwind.local: "URGENT - smoke machine for friday"' },
    { time: ago(190), level: 'send', message: 'Helen Marsh (Riverside Theatre) → sarah.collins@northwind.local: "Lighting for "An Inspector Calls""' },
    { time: ago(95), level: 'recv', message: 'Priya Shah → dave@smithaccountants.local: "Q3 VAT return"' },
    { time: ago(70), level: 'recv', message: 'Sarah Collins → helen.marsh@riversidetheatre.local: "RE: Lighting for "An Inspector Calls"" with Quote Q-4471.pdf' },
    { time: ago(35), level: 'send', message: 'Dave Smith (Smith & Co Chartered Accountants, Accountant) → priya.shah@northwind.local: "Re: Q3 VAT return"' },
    { time: ago(12), level: 'send', message: 'Helen Marsh (Riverside Theatre) → sarah.collins@northwind.local: "Re: Lighting for "An Inspector Calls""' },
    { time: ago(4), level: 'info', message: 'Gary Pike chased "URGENT - smoke machine for friday" (follow-up 1)' },
    { time: ago(4), level: 'send', message: 'Gary Pike (Pike Events) → tom.reid@northwind.local, mike.dunn@northwind.local: "Re: URGENT - smoke machine for friday"' },
    { time: ago(4), level: 'info', message: 'Gary Pike will chase if no answer within ~4 min' },
  ],
  // Inside the throwaway profile, so auto-save writes nowhere that matters.
  appState: { currentFile: path.join(profile, 'Northwind 2005.senario'), includeSecrets: false, autoSave: true },
};
fs.writeFileSync(path.join(profile, 'senario-data.json'), JSON.stringify(seed, null, 2));

// Start the real app, then drive its window.
require('../src/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = [
  ['company', `document.querySelector('[data-tab=company]').click()`],
  ['customers', `document.querySelector('[data-tab=customers]').click(); document.querySelector('#customers .person').open = true`],
  ['parties', `document.querySelector('[data-tab=parties]').click(); document.querySelector('#parties .person').open = true`],
  ['conversation', `document.querySelector('[data-tab=threads]').click()`, `document.querySelector('.thread-item[data-id=t1]').click()`, `setTimeout(() => document.querySelector('.att').open = true, 200)`],
  ['activity', `document.querySelector('[data-tab=run]').click()`],
  ['settings', `document.querySelector('[data-tab=settings]').click()`],
];

app.whenReady().then(async () => {
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await wait(100);
  win.setSize(1280, 860);
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await wait(1500);
  // Never publish this machine's real addresses: show a documentation-range IP instead.
  await win.webContents.executeJavaScript(`localIps = ['10.0.0.50']; renderRouting();`);
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, ...steps] of SHOTS) {
    for (const js of steps) {
      await win.webContents.executeJavaScript(js);
      await wait(500);
    }
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log(`docs/images/${name}.png  ${img.getSize().width}x${img.getSize().height}`);
  }
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(0);
});
