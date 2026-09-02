/* App shell: connection status, toasts, sync wiring, shared helpers. */

import * as store from './store.js';
import sync from './sync.js';

/* --------------------------------------------------------------- toasts */

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

export function buzz(pattern = 12) {
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch (e) { }
  }
}
window.buzz = buzz;

function renderStatus(state) {
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

export const money = (value) =>
  `$${(Number(value) || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
window.money = money;

export const qtyText = (value) => {
  const n = Number(value) || 0;
  return Number.isInteger(n) ? String(n) : String(n);
};

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
window.todayISO = todayISO;

/* ------------------------------------------------------- pay rate engine */

export let RATES = {
  'Installation': 110.0,
  'Fusion Splice': 15.0,
  'Place Nid w/ Riser': 12.5,
  'Temp drop laid': 20.0,
  'Trip Fee': 30.0,
  "Direct bury flat drop (0-300')": 75.0,
  "bore (0-12')": 25.0,
  'Conduit Pull Footage': 0.55,
};
export const AERIAL_ITEM = 'Aerial Drop Footage';

// Load stored rates dynamically from local storage / bootstrap
async function loadDynamicRates() {
  try {
    const cached = await store.meta('rate_table');
    if (cached && Array.isArray(cached)) {
      cached.forEach(r => {
        if (r.item && r.rate !== undefined) RATES[r.item] = parseFloat(r.rate);
      });
    }
    if (navigator.onLine) {
      const res = await fetch('/api/bootstrap');
      const data = await res.json();
      if (data.rates) {
        data.rates.forEach(r => {
          if (r.item && r.rate !== undefined) RATES[r.item] = parseFloat(r.rate);
        });
        await store.setMeta('rate_table', data.rates);
      }
    }
  } catch (e) {}
}

export function aerialPrice(feet) {
  const ft = Number(feet) || 0;
  if (ft <= 0) return 0;
  if (ft <= 300) return 75.0;
  if (ft <= 600) return 150.0;
  return Math.round((150.0 + (ft - 600) * 0.5) * 100) / 100;
}

export function itemPrice(name, qty) {
  const q = Number(qty) || 0;
  if (q <= 0) return 0;
  if (name === AERIAL_ITEM) return aerialPrice(q);
  return q * (RATES[name] || 0);
}

export function jobTotal(items) {
  return Math.round(
    Object.entries(items || {}).reduce((sum, [name, qty]) => sum + itemPrice(name, qty), 0) * 100,
  ) / 100;
}
window.jobTotal = jobTotal;
window.itemPrice = itemPrice;

/* ------------------------------------------------------- data accessors */

export async function saveJob(job) {
  const record = await store.put('jobs', {
    ...job,
    total: jobTotal(job.items),
    status: job.status || 'complete',
  });
  document.dispatchEvent(new CustomEvent('mercury:queued'));
  return record;
}

export async function saveCustomItem(item) {
  const qty = Number(item.qty) || 0;
  const rate = Number(item.rate) || 0;
  const record = await store.put('custom_items', {
    ...item,
    qty, rate,
    total: Math.round(qty * rate * 100) / 100,
    bill_to: item.bill_to === 'remc' ? 'remc' : 'mercury',
  });
  document.dispatchEvent(new CustomEvent('mercury:queued'));
  return record;
}

export async function saveScan(scan) {
  const record = await store.put('equipment_scans', scan);
  document.dispatchEvent(new CustomEvent('mercury:queued'));
  return record;
}

export async function removeRow(storeName, id) {
  const record = await store.remove(storeName, id);
  document.dispatchEvent(new CustomEvent('mercury:queued'));
  return record;
}

/* ----------------------------------------------------------------- boot */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Update ready — reopen the app to apply.', 'info', 5000);
          }
        });
      });
    } catch (e) {
      console.warn('Service worker registration failed', e);
    }
  });

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'sync-now') sync.syncNow({ silent: true });
  });
}

function wireConfirmations() {
  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-confirm]');
    if (!el) return;
    if (!window.confirm(el.dataset.confirm)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
}

function wireManualSync() {
  document.getElementById('sync-pill')?.addEventListener('click', async () => {
    if (!navigator.onLine) {
      toast('Still offline — your work is saved and will sync automatically.', 'warning');
      return;
    }
    const result = await sync.syncNow();
    if (result.error) toast(`Sync failed: ${result.error}`, 'danger');
    else if (result.pushed || result.pulled) toast('Sync complete.', 'success');
    else toast('Everything is already up to date.', 'success');
  });
}

document.addEventListener('mercury:synced', (event) => {
  const { pushed, pulled, rejected, silent } = event.detail;
  if (pushed && !silent) {
    toast(`Synced ${pushed} ${pushed === 1 ? 'entry' : 'entries'} to the server.`, 'success');
  }
  if (rejected?.length && !silent) {
    toast(`${rejected.length} ${rejected.length === 1 ? 'entry' : 'entries'} could not be synced.`, 'danger', 6000);
  }
});

function drainFlash() {
  const raw = sessionStorage.getItem('mercury:flash');
  if (!raw) return;
  sessionStorage.removeItem('mercury:flash');
  try {
    const { message, kind } = JSON.parse(raw);
    toast(message, kind || 'success', 4200);
  } catch (e) { }
}

export function init() {
  loadDynamicRates();
  registerServiceWorker();
  drainFlash();
  sync.subscribe(renderStatus);
  window.addEventListener('online', () => {
    renderStatus(sync.getState());
    toast('Back online — syncing your work.', 'success');
  });
  window.addEventListener('offline', () => {
    renderStatus(sync.getState());
    toast('Offline. Keep working — everything is saved on this device.', 'warning', 5000);
  });
  wireConfirmations();
  wireManualSync();
  sync.start();
}

export { store, sync };
window.mercury = {
  store, sync, toast, buzz, money, jobTotal, itemPrice, aerialPrice,
  saveJob, saveCustomItem, saveScan, removeRow, todayISO, RATES, AERIAL_ITEM,
};

init();
