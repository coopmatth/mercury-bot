/* Job form. */

import { itemPrice, jobTotal, money, saveJob, removeRow, toast, buzz } from './app.js';

const form = document.getElementById('job-form');
const rows = [...document.querySelectorAll('.qty-row')];
const totalEl = document.getElementById('job-total');

function collect() {
  const items = {};
  for (const row of rows) {
    const value = parseFloat(row.querySelector('.qty-input').value);
    if (Number.isFinite(value) && value > 0) items[row.dataset.item] = value;
  }
  return items;
}

function refresh() {
  const items = collect();
  for (const row of rows) {
    const name = row.dataset.item;
    const qty = items[name] || 0;
    const payEl = row.querySelector('.qty-pay');
    row.classList.toggle('active', qty > 0);
    if (qty > 0) {
      payEl.textContent = money(itemPrice(name, qty));
      payEl.classList.remove('hidden');
    } else {
      payEl.classList.add('hidden');
    }
  }
  totalEl.textContent = money(jobTotal(items));
}

for (const row of rows) {
  const input = row.querySelector('.qty-input');
  const step = parseFloat(input.step) === 1 ? 1 : 25;

  row.querySelector('.plus').addEventListener('click', () => {
    input.value = ((parseFloat(input.value) || 0) + step).toString();
    buzz();
    refresh();
  });

  row.querySelector('.minus').addEventListener('click', () => {
    const next = (parseFloat(input.value) || 0) - step;
    input.value = next > 0 ? next.toString() : '';
    buzz();
    refresh();
  });

  input.addEventListener('input', refresh);
}

refresh();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('save-btn');
  const items = collect();

  if (!Object.keys(items).length) {
    toast('Add at least one line of work before saving.', 'warning');
    return;
  }

  button.disabled = true;
  button.textContent = 'Saving…';

  try {
    await saveJob({
      id: form.id.value || undefined,
      created_at: form.created_at.value || undefined,
      work_date: form.work_date.value,
      address: form.address.value.trim(),
      order_number: form.order_number.value.trim(),
      notes: form.notes.value.trim(),
      needs_buried: document.getElementById('needs_buried').checked ? 1 : 0,
      needs_bore: document.getElementById('needs_bore').checked ? 1 : 0,
      items,
    });
    buzz([12, 40, 12]);
    sessionStorage.setItem(
      'mercury:flash',
      JSON.stringify({
        message: navigator.onLine
          ? `Job saved · ${money(jobTotal(items))}`
          : `Saved offline · ${money(jobTotal(items))} — will sync automatically`,
        kind: navigator.onLine ? 'success' : 'warning',
      }),
    );
    window.location.href = '/jobs';
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Save job';
    toast(`Could not save: ${error.message}`, 'danger');
  }
});

document.getElementById('delete-btn')?.addEventListener('click', async () => {
  await removeRow('jobs', form.id.value);
  sessionStorage.setItem(
    'mercury:flash',
    JSON.stringify({ message: 'Job deleted.', kind: 'success' }),
  );
  window.location.href = '/jobs';
});

let dirty = false;
form.addEventListener('input', () => { dirty = true; });
form.addEventListener('submit', () => { dirty = false; });
window.addEventListener('beforeunload', (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = '';
});
