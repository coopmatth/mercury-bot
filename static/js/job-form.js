/* Job form. */

import { itemPrice, jobTotal, money, saveJob, removeRow, toast, buzz, routerNav } from './app.js';
import { requiredPhotos, photoChecklist } from './photo-reqs.js';


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
  if (photoCount) {
    const list = photoChecklist(items);
    let html = '<div class="pc-head">📷 ' + photoCount + ' photo' + (photoCount === 1 ? '' : 's') + ' required</div><ol class="pc-list">';
    for (const p of list) html += '<li><span class="ck-code">' + p.code + '</span> ' + p.name + '</li>';
    html += '</ol>';
    photoEl.innerHTML = html;
  } else {
    photoEl.innerHTML = '';
  }
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

let saveInFlight = false;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  // Guard against double-submit (double-tap, router re-execution): ignore
  // while a save is already running, and reuse one stable ID so a retry
  // upserts the same record instead of creating a duplicate.
  if (saveInFlight) return;
  saveInFlight = true;
  const button = document.getElementById('save-btn');
  const items = collect();

  if (!Object.keys(items).length) {
    toast('Add at least one line of work before saving.', 'warning');
    return;
  }

  button.disabled = true;
  button.textContent = 'Saving…';

  // One stable ID per form instance: a double-submit upserts the same row.
  if (!form.id.value) form.id.value = crypto.randomUUID();
  try {
    buzz([12, 40, 12]);
    const saved = await saveJob({
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
    // Hand off to the photo compressor: which photos this job needs.
    const { total: photoCount, detail } = requiredPhotos(items);
    const photoList = [];
    detail.forEach((d) => {
      d.photos.forEach((p) => photoList.push({ code: d.code, name: p }));
    });
    const workOrderId = (form.order_number.value.trim()
      || (saved && saved.id ? String(saved.id).slice(0, 8) : ''));
    sessionStorage.setItem(
      'mercury:photo-job',
      JSON.stringify({
        jobId: saved?.id || form.id.value,
        workOrderId,
        address: form.address.value.trim(),
        total: money(jobTotal(items)),
        photoCount,
        photos: photoList,
      }),
    );
    sessionStorage.setItem(
      'mercury:flash',
      JSON.stringify({
        message: photoCount
          ? `Job saved · ${money(jobTotal(items))} · Take ${photoCount} photo${photoCount === 1 ? '' : 's'} below`
          : `Job saved · ${money(jobTotal(items))}`,
        kind: 'success',
      }),
    );
    const navJobId = saved?.id || form.id.value;
    routerNav('/photos?job=' + encodeURIComponent(navJobId));
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Save job';
    saveInFlight = false;
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
