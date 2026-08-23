/* Sync engine.
 *
 * One endpoint, one round trip: everything in the outbox goes up, everything
 * new on the server comes down. Runs on load, when connectivity returns, on
 * a slow timer, and whenever a screen asks for it.
 *
 * Failure is the normal case in the field, so a failed sync is never an
 * error the technician has to act on — the outbox simply stays put and the
 * next attempt picks it up. */

import * as store from './store.js';

const SYNC_INTERVAL = 60_000;
const RETRY_BACKOFF = [2_000, 5_000, 15_000, 30_000, 60_000];

const listeners = new Set();
let state = { status: 'idle', pending: 0, lastSync: null, error: null };
let running = false;
let retries = 0;
let timer = null;

export function subscribe(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

function emit(patch) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => {
    try { fn(state); } catch (e) { console.warn('sync listener failed', e); }
  });
}

export function getState() {
  return state;
}

async function refreshPending() {
  const pending = await store.outboxCount();
  emit({ pending });
  return pending;
}

/** Push the outbox and pull the delta. Returns a result summary. */
export async function syncNow({ silent = false } = {}) {
  if (running) return { skipped: 'already-running' };
  if (!navigator.onLine) {
    await refreshPending();
    emit({ status: 'offline' });
    return { skipped: 'offline' };
  }

  running = true;
  const pendingBefore = await refreshPending();
  if (!silent || pendingBefore) emit({ status: 'syncing', error: null });

  try {
    const entries = await store.outbox();
    const changes = {};
    for (const entry of entries) {
      (changes[entry.store] ||= []).push(entry.row);
    }

    const body = {
      device_id: await store.deviceId(),
      device_label: navigator.userAgent.slice(0, 80),
      since: Number(await store.meta('server_seq', 0)) || 0,
      changes,
    };

    const response = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Server responded ${response.status}`);
    const data = await response.json();

    // Clear only what the server actually acknowledged, so a partial
    // failure leaves the rest of the outbox intact for the next attempt.
    const rejectedIds = new Set(
      (data.rejected || []).map((r) => `${r.table}:${r.id}`),
    );
    const acknowledged = [];
    for (const [table, ids] of Object.entries(data.acknowledged || {})) {
      for (const id of ids) {
        const key = `${table}:${id}`;
        if (!rejectedIds.has(key)) acknowledged.push(key);
      }
    }
    await store.clearOutboxKeys(acknowledged);

    let pulled = 0;
    for (const name of store.STORES) {
      pulled += await store.applyServerRows(name, data.changes?.[name]);
    }
    await store.setMeta('server_seq', data.server_seq || 0);
    await store.setMeta('last_sync', new Date().toISOString());

    retries = 0;
    const pending = await refreshPending();
    emit({
      status: pending ? 'pending' : 'synced',
      lastSync: new Date().toISOString(),
      error: null,
    });

    const pushed = acknowledged.length;
    if (pushed || pulled) {
      // `silent` suppresses the toast, never the data event — a page showing
      // stale rows is worse than an extra re-render.
      document.dispatchEvent(new CustomEvent('mercury:synced', {
        detail: { pushed, pulled, rejected: data.rejected || [], silent },
      }));
    }
    return { pushed, pulled, rejected: data.rejected || [] };
  } catch (error) {
    const pending = await refreshPending();
    emit({ status: pending ? 'error' : 'offline', error: error.message });
    // Back off, but keep trying: signal in the field comes and goes.
    const delay = RETRY_BACKOFF[Math.min(retries, RETRY_BACKOFF.length - 1)];
    retries += 1;
    clearTimeout(timer);
    timer = setTimeout(() => syncNow({ silent: true }), delay);
    return { error: error.message };
  } finally {
    running = false;
  }
}

/** Ask the browser to finish the push after the app is closed, when it can. */
async function registerBackgroundSync() {
  try {
    const registration = await navigator.serviceWorker?.ready;
    if (registration && 'sync' in registration) {
      await registration.sync.register('mercury-sync');
    }
  } catch (e) {
    // Background Sync is not available everywhere (notably iOS). The
    // foreground timer below covers those browsers.
  }
}

export function start() {
  refreshPending();

  window.addEventListener('online', () => {
    retries = 0;
    emit({ status: 'syncing' });
    syncNow();
  });
  window.addEventListener('offline', () => emit({ status: 'offline' }));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow({ silent: true });
  });

  // A write anywhere in the app nudges the queue immediately.
  document.addEventListener('mercury:queued', () => {
    refreshPending();
    registerBackgroundSync();
    syncNow({ silent: true });
  });

  setInterval(() => syncNow({ silent: true }), SYNC_INTERVAL);
  syncNow({ silent: true });
}

export default { start, syncNow, subscribe, getState };
