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
    el.value = k === 'openingBalance' ? ((Number(a.openingBalance) || 0) / 100).toFixed(2) : a[k] || '';
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

$('#sendStatement').addEventListener('click', (e) =>
  busy(e.target, async () => {
    await window.api.sendStatement({ to: [$('#stmtTo').value], from: $('#stmtFrom').value, until: $('#stmtUntil').value });
    toast('Statement emailed');
  })
);

$('#tab-bank').addEventListener('click', (e) => {
  const now = e.target.closest('[data-pay-now]');
  const cancel = e.target.closest('[data-pay-cancel]');
  const remove = e.target.closest('[data-tx-remove]');
  if (now) busy(now, async () => { await window.api.payNow(now.dataset.payNow); await loadBank(); });
  if (cancel && confirm('Cancel this payment? The customer will not pay this invoice.')) busy(cancel, async () => { await window.api.cancelPayment(cancel.dataset.payCancel); await loadBank(); });
  if (remove && confirm('Remove this transaction from the account?')) busy(remove, async () => { await window.api.removeTransaction(remove.dataset.txRemove); await loadBank(); });
});

tabHooks.bank = loadBank;
