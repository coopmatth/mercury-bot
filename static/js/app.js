/* App shell: connection status, toasts, sync wiring, shared helpers. */

import * as store from './store.js';
import sync from './sync.js';
import { isNativeApp, openFile } from './native.js';
import {
  money as _money, itemPrice as _itemPrice, jobTotal as _jobTotal,
  todayISO as _todayISO,
} from './rates.js';
import {
  money, qtyText, todayISO, RATES, RATE_ALIASES, FOOTAGE_ITEMS,
  canonicalName, loadDynamicRates, itemPrice, jobTotal,
  setApiBase, apiUrl,
} from './rates.js';
export {
  money, qtyText, todayISO, RATES, RATE_ALIASES, FOOTAGE_ITEMS,
  canonicalName, loadDynamicRates, itemPrice, jobTotal,
  setApiBase, apiUrl,
};
window.money = _money;
window.itemPrice = _itemPrice;
window.jobTotal = _jobTotal;
window.todayISO = _todayISO;

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
  // Register immediately rather than on window load: the earlier the
  // worker installs, the sooner the offline cache exists, and a slow
  // page must not delay it.
  (async () => {
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
  })();

  if (document.readyState === 'complete') {
    navigator.serviceWorker.getRegistration().then((r) => r?.update().catch(() => {}));
  } else {
    window.addEventListener('load', () => {
      navigator.serviceWorker.getRegistration().then((r) => r?.update().catch(() => {}));
    });
  }

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
  store, sync, toast, buzz, money, jobTotal, itemPrice,
  saveJob, saveCustomItem, saveScan, removeRow, todayISO, RATES,
};

init();

/* ------------------------------------------------- seamless navigation router */

/** Navigate via the SPA router (no full page load, no white flash).
 * Used by form save handlers that previously did location.href jumps. */
export function routerNav(url) {
  const a = document.createElement('a');
  a.href = url;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
window.routerNav = routerNav;

document.addEventListener('click', async (event) => {
  const link = event.target.closest('a');
  if (!link || !link.href) return;

  const url = new URL(link.href);
  if (url.origin !== window.location.origin) return;
  if (link.hasAttribute('download') || link.getAttribute('target') === '_blank') return;
  if (link.href.startsWith('mailto:') || link.href.startsWith('tel:')) return;

  event.preventDefault();
  const targetUrl = link.href;

  if (link.classList.contains('tab')) {
    document.querySelectorAll('.tabbar .tab').forEach(t => t.classList.remove('active'));
    link.classList.add('active');
  }

  try {
    // Page cache: serve from memory if we've been here before
    if (!window._pageCache) window._pageCache = new Map();
    let html;
    const skipCache = targetUrl.includes("/fieldmap");
    if (!skipCache && window._pageCache.has(targetUrl)) {
      html = window._pageCache.get(targetUrl);
    } else {
      const res = await fetch(targetUrl);
      html = await res.text();
      // Cache it (max 10 pages)
      if (window._pageCache.size >= 10) {
        const firstKey = window._pageCache.keys().next().value;
        window._pageCache.delete(firstKey);
      }
      if (!skipCache) window._pageCache.set(targetUrl, html);
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const currentMain = document.querySelector('main.container');
    const newMain = doc.querySelector('main.container');

    if (currentMain && newMain) {
      // 1. Trigger the CSS fade-out animation
      currentMain.classList.add('nav-fade');
      
      // 2. Wait exactly 150ms for the transition to finish
      await new Promise(resolve => setTimeout(resolve, 150));

      // 3. Swap the HTML while the screen is faded out
      currentMain.innerHTML = newMain.innerHTML;
      
      doc.querySelectorAll('body script').forEach(script => {
        if (script.src && (script.src.includes('app.js') || script.src.includes('hydrate.js'))) return;
        const newScript = document.createElement('script');
        if (script.src) {
          // ES modules are singletons: re-adding the same src does NOT
          // re-execute. Bust the cache so page scripts (e.g. job-form.js)
          // re-initialize against the freshly swapped DOM.
          const url = new URL(script.src, window.location.origin);
          url.searchParams.set('_r', Date.now().toString());
          newScript.src = url.toString();
        }
        if (script.type) newScript.type = script.type;
        newScript.textContent = script.textContent;
        document.body.appendChild(newScript);
      });

      document.title = doc.title;
      window.history.pushState({}, '', targetUrl);
      window.scrollTo(0, 0);

      // 4. Fade the new content back in
      currentMain.classList.remove('nav-fade');
    }
  } catch (err) {
    window.location.href = targetUrl;
  }
});

window.addEventListener('popstate', () => window.location.reload());
/* ------------------------------------------- native iOS download bypass */
document.addEventListener('click', async (event) => {
  // WKWebView ignores <a download>, so inside the packaged app fetch the
  // file and hand it to iOS instead. In a real browser the download
  // attribute works on its own, so leave those clicks alone.
  // (This used to assume every download was a photo and named it
  // "compressed_image.jpg" — which is why the spreadsheet buttons handed
  // you a photo file. It now keeps the real file and filename.)
  const downloadLink = event.target.closest('a[download]');
  if (!downloadLink || !isNativeApp()) return;

  event.preventDefault(); // Stop the default webview download block

  try {
    const response = await fetch(downloadLink.href);
    const blob = await response.blob();

    // The links carry a bare `download` attribute, so prefer the
    // server's Content-Disposition filename (e.g. the .xlsx name).
    const disposition = response.headers.get('Content-Disposition') || '';
    const serverName = /filename="([^"]+)"/.exec(disposition)?.[1];
    const filename = serverName || downloadLink.download || 'download';

    // Prefer the native "Open In…" menu — it lists every app that handles
    // the file type (Excel for .xlsx), which the share sheet buries.
    if (await openFile(blob, filename)) return;

    // Fallback: the iOS share sheet.
    if (navigator.share) {
      const file = new File([blob], filename,
        { type: blob.type || 'application/octet-stream' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
      } else {
        window.location.href = downloadLink.href;
      }
    } else {
      window.location.href = downloadLink.href;
    }
  } catch (err) {
    console.error('Failed to open download:', err);
  }
});
