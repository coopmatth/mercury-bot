/* Mercury offline shell.
 *
 * The iOS webview exposes no service worker, so a cold start with no signal
 * can never load the server-rendered site. This shell is bundled with the
 * app instead: it paints instantly from the on-device IndexedDB replica and
 * syncs through the same engine (and the same API) whenever there is a
 * connection. Core field flows — dashboard, jobs, logging — work identically
 * with four bars or none.
 *
 * Only pure modules are imported here (store, sync, rates, local, hydrate).
 * app.js is deliberately NOT imported: its seamless-navigation router
 * assumes server-rendered pages.
 */

import * as store from './store.js';
import sync from './sync.js';
import {
  setApiBase, loadDynamicRates, money, itemPrice, jobTotal,
  RATES, FOOTAGE_ITEMS, todayISO,
} from './rates.js';
import { weekSummary, weekBounds, niceDate } from './local.js';
import { renderDashboard, renderJobs, rateLabel } from './hydrate.js';

const SERVER = 'https://discord-dnb20-series.tailc835fa.ts.net';
setApiBase(SERVER);

/* ------------------------------------------------------------------ toast */

const ICONS = { success: '✓', danger: '!', warning: '⚠', info: 'i' };

export function toast(message, kind = 'info', ms = 3600) {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="toast-icon">${ICONS[kind] || ICONS.info}</span><span></span>`;
  el.lastElementChild.textContent = message;
  host.appendChild(el);
  const close = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  };
  el.addEventListener('click', close);
  setTimeout(close, ms);
  return close;
}
window.toast = toast;

function buzz(pattern = 12) {
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch (e) { }
  }
}

/* hydrate's customRow calls these globals for its delete button. */
window.mercury = {
  store,
  sync,
  async removeRow(storeName, id) {
    const record = await store.remove(storeName, id);
    document.dispatchEvent(new CustomEvent('mercury:queued'));
    return record;
  },
};

/* -------------------------------------------------------------- sync pill */

function renderPill(state) {
  const pill = document.getElementById('sync-pill');
  if (!pill) return;

  const online = navigator.onLine;
  document.body.classList.toggle('is-offline', !online);

  let cls = 'pill pill-online';
  let text = 'Synced';
  let pulse = '';

  if (!online) {
    cls = 'pill pill-offline';
    text = state.pending ? `${state.pending} queued · Offline` : 'Offline';
  } else if (state.status === 'syncing') {
    cls = 'pill pill-syncing';
    text = 'Syncing…';
    pulse = ' dot-pulse';
  } else if (state.status === 'error') {
    cls = 'pill pill-error';
    text = state.pending ? `${state.pending} waiting` : 'Sync failed';
  } else if (state.pending) {
    cls = 'pill pill-syncing';
    text = `${state.pending} to sync`;
  }

  pill.className = cls;
  pill.innerHTML = `<span class="dot${pulse}"></span><span></span>`;
  pill.lastElementChild.textContent = text;
  pill.title = state.lastSync
    ? `Last synced ${new Date(state.lastSync).toLocaleTimeString()}`
    : 'Not synced yet';
}

/* ------------------------------------------------------------ view router */

const views = [...document.querySelectorAll('[data-view]')];
let currentView = 'home';

function showView(name) {
  currentView = name;
  for (const v of views) v.hidden = v.dataset.view !== name;
  document.querySelectorAll('.tabbar .tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.viewLink === name));
  window.scrollTo(0, 0);
  if (name === 'home') renderHome();
  if (name === 'jobs') renderJobsView();
  if (name === 'settings') renderSettings();
  if (name === 'log') openLog();
}

document.addEventListener('click', (event) => {
  const nav = event.target.closest('[data-view-link]');
  if (nav) {
    event.preventDefault();
    showView(nav.dataset.viewLink);
    return;
  }
  /* Links rendered by hydrate (job rows, empty states) point at server
   * paths — route them to shell views instead of fetching. */
  const link = event.target.closest('a[href^="/jobs"]');
  if (link) {
    event.preventDefault();
    const m = /^\/jobs\/([^/]+)\/edit/.exec(new URL(link.href).pathname);
    if (m) openLog(m[1]);
    else if (new URL(link.href).pathname === '/jobs/new') showView('log');
    else showView('jobs');
  }
});

/* ------------------------------------------------------------------ home */

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

async function renderHome() {
  const { start, end } = weekBounds();
  const summary = await weekSummary(start, end);
  const pending = await pendingIds();

  document.getElementById('greeting').textContent = greeting();
  document.getElementById('today-name').textContent =
    new Date().toLocaleDateString('en-US', { weekday: 'long' });
  document.getElementById('week-range').textContent =
    `${niceDate(start)} – ${niceDate(end)}`;
  document.getElementById('week-badge').textContent =
    `${niceDate(start, { month: 'short', day: 'numeric' })} – ${niceDate(end, { month: 'short', day: 'numeric' })}`;
  document.getElementById('offline-note').textContent =
    navigator.onLine ? '' : 'Offline — showing saved data';

  renderDashboard(summary, pending);
}

async function pendingIds() {
  const entries = await store.outbox();
  return new Set(entries.map((e) => e.row.id));
}

/* ------------------------------------------------------------------ jobs */

async function renderJobsView() {
  const { start, end } = weekBounds();
  const summary = await weekSummary(start, end);
  const pending = await pendingIds();
  renderJobs(summary, pending);
}

document.getElementById('job-search')?.addEventListener('input', (e) => {
  const q = e.target.value;
  const url = new URL(window.location.href);
  if (q) url.searchParams.set('q', q);
  else url.searchParams.delete('q');
  window.history.replaceState(null, '', url);
  renderJobsView();
});

/* ------------------------------------------------------------------- log */

function rateRow(name, qty) {
  const footage = FOOTAGE_ITEMS.has(name);
  const row = document.createElement('div');
  row.className = 'qty-row' + (qty ? ' active' : '');
  row.dataset.item = name;
  row.innerHTML = `
    <div class="qty-info">
      <div class="qty-name"></div>
      <div class="qty-rate"></div>
      <div class="qty-pay hidden"></div>
    </div>
    <div class="stepper">
      <button type="button" class="step-btn minus" aria-label="Decrease">−</button>
      <input type="number" class="qty-input ${footage ? 'wide' : ''}"
             inputmode="decimal" step="${footage ? '0.01' : '1'}" min="0"
             placeholder="0" aria-label="">
      <button type="button" class="step-btn plus" aria-label="Increase">+</button>
    </div>`;
  row.querySelector('.qty-name').textContent = name;
  row.querySelector('.qty-rate').textContent = rateLabel(name);
  const input = row.querySelector('.qty-input');
  input.setAttribute('aria-label', `${name} quantity`);
  if (qty) input.value = qty;

  const refresh = () => refreshForm();
  row.querySelector('.plus').addEventListener('click', () => {
    const step = footage ? 25 : 1;
    input.value = ((parseFloat(input.value) || 0) + step).toString();
    buzz();
    refreshForm();
  });
  row.querySelector('.minus').addEventListener('click', () => {
    const step = footage ? 25 : 1;
    const next = (parseFloat(input.value) || 0) - step;
    input.value = next > 0 ? String(Math.round(next * 100) / 100) : '';
    refreshForm();
  });
  input.addEventListener('input', refreshForm);
  return row;
}

function collectItems() {
  const items = {};
  for (const row of document.querySelectorAll('#f-items .qty-row')) {
    const value = parseFloat(row.querySelector('.qty-input').value);
    if (Number.isFinite(value) && value > 0) items[row.dataset.item] = value;
  }
  return items;
}

function refreshForm() {
  const items = collectItems();
  for (const row of document.querySelectorAll('#f-items .qty-row')) {
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
  document.getElementById('f-total').textContent = money(jobTotal(items));
}

async function openLog(id) {
  const form = document.getElementById('job-form');
  form.reset();
  document.getElementById('f-id').value = id || '';
  document.getElementById('f-delete').hidden = !id;
  document.getElementById('log-title').textContent = id ? 'Edit job' : 'Log a job';
  document.getElementById('f-save').textContent = id ? 'Save changes' : 'Save job';

  const host = document.getElementById('f-items');
  host.innerHTML = '';
  let job = null;
  if (id) job = await store.get('jobs', id);

  document.getElementById('f-work_date').value = job?.work_date || todayISO();
  document.getElementById('f-address').value = job?.address || '';
  document.getElementById('f-order_number').value = job?.order_number || '';
  document.getElementById('f-notes').value = job?.notes || '';
  document.getElementById('f-needs_buried').checked = !!job?.needs_buried;
  document.getElementById('f-needs_bore').checked = !!job?.needs_bore;

  for (const name of Object.keys(RATES)) {
    host.appendChild(rateRow(name, job?.items?.[name] || 0));
  }
  refreshForm();
  showView('log');
}

document.getElementById('job-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('f-save');
  const items = collectItems();

  if (!Object.keys(items).length) {
    toast('Add at least one line of work before saving.', 'warning');
    return;
  }

  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const id = document.getElementById('f-id').value || undefined;
    const existing = id ? await store.get('jobs', id) : null;
    await store.put('jobs', {
      ...(existing || {}),
      id,
      work_date: document.getElementById('f-work_date').value,
      address: document.getElementById('f-address').value.trim(),
      order_number: document.getElementById('f-order_number').value.trim(),
      notes: document.getElementById('f-notes').value.trim(),
      needs_buried: document.getElementById('f-needs_buried').checked ? 1 : 0,
      needs_bore: document.getElementById('f-needs_bore').checked ? 1 : 0,
      items,
      total: jobTotal(items),
      status: existing?.status || 'complete',
    });
    document.dispatchEvent(new CustomEvent('mercury:queued'));
    buzz([12, 40, 12]);
    toast(
      navigator.onLine
        ? `Job saved · ${money(jobTotal(items))}`
        : `Saved offline · ${money(jobTotal(items))} — will sync automatically`,
      navigator.onLine ? 'success' : 'warning',
    );
    showView('jobs');
  } catch (error) {
    toast(`Could not save: ${error.message}`, 'danger');
  } finally {
    button.disabled = false;
    button.textContent = document.getElementById('f-id').value ? 'Save changes' : 'Save job';
  }
});

document.getElementById('f-delete').addEventListener('click', async () => {
  const id = document.getElementById('f-id').value;
  if (!id || !window.confirm('Delete this job? This cannot be undone.')) return;
  await store.remove('jobs', id);
  document.dispatchEvent(new CustomEvent('mercury:queued'));
  toast('Job deleted.', 'success');
  showView('jobs');
});

/* --------------------------------------------------------------- settings */

async function renderSettings() {
  const state = sync.getState();
  document.getElementById('s-status').textContent =
    !navigator.onLine ? 'Offline' : state.status === 'syncing' ? 'Syncing…' : 'Connected';
  document.getElementById('s-device').textContent =
    (await store.deviceId()).slice(0, 13) + '…';
  document.getElementById('s-pending').textContent = await store.outboxCount();
  const last = await store.meta('last_sync');
  document.getElementById('s-last').textContent =
    last ? new Date(last).toLocaleString() : 'never';
}

document.getElementById('s-sync').addEventListener('click', async () => {
  if (!navigator.onLine) {
    toast('Still offline — your work is saved and will sync automatically.', 'warning');
    return;
  }
  const result = await sync.syncNow();
  if (result.error) toast(`Sync failed: ${result.error}`, 'danger');
  else toast(`Pushed ${result.pushed || 0}, pulled ${result.pulled || 0}.`, 'success');
  renderSettings();
});

document.querySelectorAll('[data-fullsite]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!navigator.onLine) {
      toast('That needs a connection — your logged work is safe offline.', 'warning');
      return;
    }
    window.location.href = SERVER + btn.dataset.fullsite;
  });
});

document.getElementById('sync-pill').addEventListener('click', async () => {
  if (!navigator.onLine) {
    toast('Still offline — your work is saved and will sync automatically.', 'warning');
    return;
  }
  const result = await sync.syncNow();
  if (result.error) toast(`Sync failed: ${result.error}`, 'danger');
  else if (result.pushed || result.pulled) toast('Sync complete.', 'success');
  else toast('Everything is already up to date.', 'success');
});

/* ------------------------------------------------------------------- boot */

function rerender() {
  if (currentView === 'home') renderHome();
  else if (currentView === 'jobs') renderJobsView();
  else if (currentView === 'settings') renderSettings();
}

document.addEventListener('mercury:synced', rerender);
document.addEventListener('mercury:queued', () => { renderPill(sync.getState()); rerender(); });
document.addEventListener('mercury:data-changed', rerender);

sync.subscribe(renderPill);
window.addEventListener('online', () => {
  renderPill(sync.getState());
  toast('Back online — syncing your work.', 'success');
  rerender();
});
window.addEventListener('offline', () => {
  renderPill(sync.getState());
  toast('Offline. Keep working — everything is saved on this device.', 'warning', 5000);
  rerender();
});

await loadDynamicRates();
sync.start();
showView('home');
