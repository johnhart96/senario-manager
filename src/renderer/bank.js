'use strict';

// Bank tab: the company's account, payments customers have promised, and statements.

let bankState = null;

function fmtMoney(minor, { sign = false } = {}) {
  const cur = (bankState && bankState.account.currency) || 'GBP';
  const v = (Number(minor) || 0) / 100;
  let s;
  try { s = new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }).format(Math.abs(v)); } catch { s = `${cur} ${Math.abs(v).toFixed(2)}`; }
  return v < 0 ? `-${s}` : sign && v > 0 ? `+${s}` : s;
}
const fmtDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtIn = (due) => {
  const min = Math.max(0, Math.round((due - Date.now()) / 60000));
  return min < 60 ? `${min} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`;
};

async function loadBank() {
  bankState = await window.api.bank();
  const b = bankState;
  const a = b.account;
  for (const el of $$('[data-bank]')) {
    const k = el.dataset.bank;
    if (document.activeElement === el) continue;
    el.value = k === 'openingBalance' || k === 'overdraftLimit' ? ((Number(a[k]) || 0) / 100).toFixed(2) : a[k] || '';
  }
  $('#bankBalance').textContent = fmtMoney(b.balance);
  $('#bankBalance').classList.toggle('neg', b.balance < 0);
  $('#bankExpectedTotal').textContent = b.expected.length
    ? `${fmtMoney(b.expected.reduce((n, p) => n + p.amount, 0))} expected from ${b.expected.length} payment${b.expected.length > 1 ? 's' : ''}` : 'No payments expected';

  // Statement: who gets it (accounts staff first) and a default period of this month.
  const staff = (company && company.employees) || [];
  const money = /account|financ|bookkeep|credit control|payable|receivable/i;
  const pickFirst = staff.find((e) => money.test(e.role || '')) || staff.find((e) => money.test(e.responsibilities || '')) || staff[0];
  const sel = $('#stmtTo');
  const chosen = sel.value;
  sel.innerHTML = staff.length ? staff.map((e) => `<option value="${esc(e.email)}">${esc(e.name)}${e.role ? ` (${esc(e.role)})` : ''}</option>`).join('') : '<option value="">Add employees first</option>';
  sel.value = chosen || (pickFirst ? pickFirst.email : '');
  if (!$('#stmtFrom').value) $('#stmtFrom').value = `${b.today.slice(0, 8)}01`;
  if (!$('#stmtUntil').value) $('#stmtUntil').value = b.today;
  if (!$('#txDate').value) $('#txDate').value = b.today;
  if (!$('#ddStart').value) $('#ddStart').value = b.today;
  $('#bankDd').innerHTML = b.directDebits.length
    ? `<table class="rtable"><thead><tr><th>Payee</th><th>Reference</th><th class="n">Amount</th><th>Frequency</th><th>Next payment</th><th class="n">Paid so far</th><th></th></tr></thead><tbody>${b.directDebits.map((d) => `<tr>
        <td>${esc(d.payee)}</td><td>${esc(d.reference || '–')}</td><td class="n">${fmtMoney(d.amount)}</td><td>${esc(d.frequencyLabel)}</td>
        <td>${fmtDay(d.nextDate)}</td><td class="n">${d.collected}</td>
        <td class="n"><button class="link danger" data-dd-remove="${esc(d.id)}">Cancel</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted small">No direct debits.</p>';

  // Online banking.
  const o = b.online;
  if (document.activeElement !== $('#webBind')) $('#webBind').value = o.bindAddress || '0.0.0.0';
  if (document.activeElement !== $('#webPort')) $('#webPort').value = o.port || 80;
  $('#webEnabled').checked = o.enabled;
  $('#openWeb').disabled = !o.webRunning;
  const ips = typeof localIps !== 'undefined' && localIps.length ? localIps : ['<this machine>'];
  const urls = (o.bindAddress && o.bindAddress !== '0.0.0.0' ? [o.bindAddress] : ips).map((ip) => `http://${ip}${Number(o.port) === 80 ? '' : `:${o.port}`}/`);
  $('#webStatus').innerHTML = !o.enabled ? '<span class="muted">Off.</span>'
    : o.webRunning ? `<span class="ok-text">● Running</span> at ${urls.map(esc).join(', ')}${o.users.length ? '' : ' · <span class="err-text">add a user so someone can log in</span>'}`
      : `<span class="err-text">● Not running: ${esc(o.webError || 'starting…')}</span>`;
  $('#webUsers').innerHTML = o.users.length
    ? `<table class="rtable"><thead><tr><th>Name</th><th>Username</th><th></th></tr></thead><tbody>${o.users.map((u) => `<tr>
        <td>${esc(u.name || '')}</td><td>${esc(u.username)}</td><td class="n"><button class="link danger" data-web-remove="${esc(u.username)}">Remove</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted small">No users yet.</p>';

  $('#bankExpected').innerHTML = b.expected.length
    ? `<table class="rtable"><thead><tr><th>From</th><th>Invoice</th><th class="n">Amount</th><th>Due in</th><th></th></tr></thead><tbody>${b.expected.map((p) => `<tr>
        <td>${esc(p.payer)}</td><td>${esc(p.reference || '–')}</td><td class="n">${fmtMoney(p.amount)}</td>
        <td>${b.running ? `about ${fmtIn(p.due)}` : 'when the scenario is running'}</td>
        <td class="n"><button class="link" data-pay-now="${esc(p.id)}">Pay now</button> · <button class="link danger" data-pay-cancel="${esc(p.id)}">Cancel</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">None. When an employee emails a customer an invoice, the customer agrees to pay it in their reply and the payment shows here until it arrives.</p>';

  $('#bankTx').innerHTML = b.transactions.length
    ? `<table class="rtable"><thead><tr><th>Date</th><th>Description</th><th class="n">Paid out</th><th class="n">Paid in</th><th class="n">Balance</th><th></th></tr></thead><tbody>${b.transactions.map((t) => `<tr>
        <td>${fmtDay(t.date)}</td><td>${esc(t.description)}</td>
        <td class="n">${t.amount < 0 ? fmtMoney(-t.amount) : ''}</td><td class="n ok">${t.amount > 0 ? fmtMoney(t.amount) : ''}</td>
        <td class="n">${fmtMoney(t.balance)}</td><td class="n"><button class="link" data-tx-remove="${esc(t.id)}" title="Remove">✕</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">No transactions yet.</p>';
}

$('#saveBankAccount').addEventListener('click', (e) =>
  busy(e.target, async () => {
    const patch = Object.fromEntries($$('[data-bank]').map((el) => [el.dataset.bank, el.value]));
    await window.api.setBankAccount(patch);
    await loadBank();
    toast('Bank account saved');
  })
);

$('#addTx').addEventListener('click', (e) =>
  busy(e.target, async () => {
    const amount = Number($('#txAmount').value);
    const out = $('#txDirection').value === 'out';
    await window.api.addTransaction({ date: $('#txDate').value, description: $('#txDesc').value, amount: out ? -Math.abs(amount) : Math.abs(amount) });
    $('#txDesc').value = '';
    $('#txAmount').value = '';
    await loadBank();
  })
);

$('#addDd').addEventListener('click', (e) =>
  busy(e.target, async () => {
    await window.api.addDirectDebit({ payee: $('#ddPayee').value, reference: $('#ddRef').value, amount: $('#ddAmount').value, frequency: $('#ddFreq').value, startDate: $('#ddStart').value });
    $('#ddPayee').value = '';
    $('#ddRef').value = '';
    $('#ddAmount').value = '';
    await loadBank();
    toast('Direct debit set up');
  })
);

$('#sendStatement').addEventListener('click', (e) =>
  busy(e.target, async () => {
    await window.api.sendStatement({ to: [$('#stmtTo').value], from: $('#stmtFrom').value, until: $('#stmtUntil').value });
    toast('Statement emailed');
  })
);

$('#saveWeb').addEventListener('click', (e) =>
  busy(e.target, async () => {
    const st = await window.api.setOnlineBanking({ enabled: $('#webEnabled').checked, bindAddress: $('#webBind').value, port: $('#webPort').value });
    await loadBank();
    if (st.online.enabled && st.online.webRunning) toast('Online banking is running');
    else if (st.online.enabled) toast(st.online.webError || 'Online banking could not start', true);
    else toast('Online banking is off');
  })
);

$('#openWeb').addEventListener('click', () => window.api.openBankSite());

$('#addWebUser').addEventListener('click', (e) =>
  busy(e.target, async () => {
    await window.api.addBankUser({ name: $('#webUserName').value, username: $('#webUserLogin').value, password: $('#webUserPass').value });
    $('#webUserName').value = '';
    $('#webUserLogin').value = '';
    $('#webUserPass').value = '';
    await loadBank();
    toast('User saved');
  })
);

$('#tab-bank').addEventListener('click', (e) => {
  const rmUser = e.target.closest('[data-web-remove]');
  if (rmUser && confirm(`Remove the online banking user "${rmUser.dataset.webRemove}"?`)) {
    busy(rmUser, async () => { await window.api.removeBankUser(rmUser.dataset.webRemove); await loadBank(); });
  }
  const now = e.target.closest('[data-pay-now]');
  const cancel = e.target.closest('[data-pay-cancel]');
  const remove = e.target.closest('[data-tx-remove]');
  const ddRemove = e.target.closest('[data-dd-remove]');
  if (ddRemove && confirm('Cancel this direct debit? Payments already taken stay on the account.')) {
    busy(ddRemove, async () => { await window.api.removeDirectDebit(ddRemove.dataset.ddRemove); await loadBank(); });
  }
  if (now) busy(now, async () => { await window.api.payNow(now.dataset.payNow); await loadBank(); });
  if (cancel && confirm('Cancel this payment? The customer will not pay this invoice.')) busy(cancel, async () => { await window.api.cancelPayment(cancel.dataset.payCancel); await loadBank(); });
  if (remove && confirm('Remove this transaction from the account?')) busy(remove, async () => { await window.api.removeTransaction(remove.dataset.txRemove); await loadBank(); });
});

tabHooks.bank = loadBank;
