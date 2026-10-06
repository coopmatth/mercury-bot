/* Job form. */

import { itemPrice, jobTotal, money, saveJob, removeRow, toast, buzz, routerNav } from './app.js';

/* Required validation photos per charge code (from contractor rate sheet).
   All photos must be timestamped. */
const PHOTO_REQS = {
  'R1': ['ONT and router placement', 'Wall entry point', 'Speedtest', 'Light level at ONT'],
  'A1': ['Each attachment point', 'Wire run to NID', 'Documentation of route taken'],
  'D2': ['Light reading at NID after burial', 'Burial route', 'Structure', 'NID with riser guard'],
  'D6': ['Mule string at start of conduit', 'Mule string at end of conduit', 'Cable in/out of conduit (match entered length)'],
  'D5': ['Photo of location'],
  'D7': ['NID mounting with riser guard', 'Inside of the NID'],
  'D8': ['Splice case (if in terminal)', 'Power meter showing passing light at NID'],
  'D11': ['Path of drop', 'Beginning of temp drop', 'End of temp drop'],
  'D10': [],
};

function codeOf(itemName) {
  const m = /^(R1|A1|D2|D6|D5|D7|D8|D11|D10)/.exec(itemName || '');
  return m ? m[1] : null;
}

function requiredPhotos(items) {
  let total = 0;
  const detail = [];
  for (const name of Object.keys(items)) {
    const code = codeOf(name);
    const photos = code ? (PHOTO_REQS[code] || []) : [];
    if (photos.length) {
      total += photos.length;
      detail.push({ code, name, photos });
    }
  }
  return { total, detail };
}

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
  const { total: photoCount } = requiredPhotos(items);
  let photoEl = document.getElementById('job-photos');
  if (!photoEl) {
    photoEl = document.createElement('div');
    photoEl.id = 'job-photos';
    photoEl.className = 'photo-count';
    totalEl.parentElement.appendChild(photoEl);
  }
  photoEl.textContent = photoCount
    ? `📷 ${photoCount} photo${photoCount === 1 ? '' : 's'} required`
    : '';
}

for (const row of rows) {
  // Idempotent: the router may re-execute this module on navigation.
  // Skip rows that already have listeners to avoid double-counting.
  if (row.dataset.wired) continue;
  row.dataset.wired = '1';

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
        message: (() => {
          const { total: photoCount } = requiredPhotos(items);
          const photoMsg = photoCount
            ? ` · You need ${photoCount} photo${photoCount === 1 ? '' : 's'} for these tasks to be paid`
            : '';
          return navigator.onLine
            ? `Job saved · ${money(jobTotal(items))}${photoMsg}`
            : `Saved offline · ${money(jobTotal(items))}${photoMsg} — will sync automatically`;
        })(),
        kind: navigator.onLine ? 'success' : 'warning',
      }),
    );
    routerNav('/jobs');
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
  routerNav('/jobs');
});

let dirty = false;
form.addEventListener('input', () => { dirty = true; });
form.addEventListener('submit', () => { dirty = false; });
window.addEventListener('beforeunload', (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

// Field-map handoff: the Map tab can stash measured footage here, then route
// to /jobs/new. Applies once, to a brand-new form only — never clobbers an
// edit in progress.
try {
  const raw = sessionStorage.getItem('mercury:job-prefill');
  if (raw && !form.id.value) {
    const pre = JSON.parse(raw);
    sessionStorage.removeItem('mercury:job-prefill');
    if (pre.address) form.address.value = String(pre.address);
    if (pre.notes) {
      form.notes.value = form.notes.value
        ? `${form.notes.value}\n${pre.notes}`
        : String(pre.notes);
    }
    let applied = 0;
    for (const [name, qty] of Object.entries(pre.items || {})) {
      const row = rows.find((r) => r.dataset.item === name);
      const value = Number(qty);
      if (row && Number.isFinite(value) && value > 0) {
        row.querySelector('.qty-input').value = value;
        applied += 1;
      }
    }
    if (applied) {
      refresh();
      toast(`Filled ${applied} line${applied === 1 ? '' : 's'} from your field map.`, 'success');
    }
  }
} catch {
  /* malformed prefill — ignore */
}
