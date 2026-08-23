/* Local database.
 *
 * IndexedDB holds a full replica of the technician's data plus an outbox of
 * writes that have not reached the server yet. Every screen reads from here,
 * never straight from the network, so the app behaves identically with four
 * bars or none at all. */

const DB_NAME = 'mercury';
const DB_VERSION = 2;

export const STORES = ['jobs', 'custom_items', 'equipment_scans'];

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          store.createIndex('work_date', 'work_date', { unique: false });
          store.createIndex('updated_at', 'updated_at', { unique: false });
        }
      }
      // The outbox is an append-only list of pending writes, keyed by
      // "<store>:<id>" so re-editing a queued row replaces it instead of
      // stacking a second copy.
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (event.oldVersion && event.oldVersion < 2) {
        // Force a full re-pull after a schema change.
        try { req.transaction.objectStore('meta').delete('server_seq'); } catch (e) {}
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* -------------------------------------------------------------- metadata */

export async function meta(key, fallback = null) {
  const db = await open();
  const store = db.transaction('meta', 'readonly').objectStore('meta');
  const row = await request(store.get(key));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  const db = await open();
  const store = db.transaction('meta', 'readwrite').objectStore('meta');
  return request(store.put({ key, value }));
}

export async function deviceId() {
  let id = await meta('device_id');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
    await setMeta('device_id', id);
  }
  return id;
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/* ----------------------------------------------------------------- reads */

export async function all(storeName) {
  const db = await open();
  const store = db.transaction(storeName, 'readonly').objectStore(storeName);
  const rows = await request(store.getAll());
  return rows.filter((r) => !r.deleted);
}

export async function get(storeName, id) {
  const db = await open();
  const store = db.transaction(storeName, 'readonly').objectStore(storeName);
  return request(store.get(id));
}

export async function inRange(storeName, start, end) {
  const rows = await all(storeName);
  return rows
    .filter((r) => r.work_date >= start && r.work_date <= end)
    .sort((a, b) => (b.work_date + b.created_at).localeCompare(a.work_date + a.created_at));
}

/* ---------------------------------------------------------------- writes */

/** Save a row locally and queue it for the server. Returns the saved row. */
export async function put(storeName, row, { queue = true } = {}) {
  const now = new Date().toISOString();
  const record = {
    ...row,
    id: row.id || uuid(),
    created_at: row.created_at || now,
    updated_at: now,
    deleted: row.deleted ? 1 : 0,
    device_id: row.device_id || (await deviceId()),
  };
  const db = await open();
  const names = queue ? [storeName, 'outbox'] : [storeName];
  const transaction = db.transaction(names, 'readwrite');
  transaction.objectStore(storeName).put(record);
  if (queue) {
    transaction.objectStore('outbox').put({
      key: `${storeName}:${record.id}`,
      store: storeName,
      row: record,
      queued_at: now,
    });
  }
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  return record;
}

/** Soft-delete: the tombstone syncs, so the row stays deleted everywhere. */
export async function remove(storeName, id) {
  const existing = await get(storeName, id);
  if (!existing) return null;
  return put(storeName, { ...existing, deleted: 1 });
}

/** Apply rows the server sent us. Never queued — they came from the server. */
export async function applyServerRows(storeName, rows) {
  if (!rows || !rows.length) return 0;

  // Read the pending outbox entries first, in their own transaction. An
  // IndexedDB transaction auto-closes once the event loop turns, so the
  // write below must not await anything once it has started.
  const pending = new Map();
  for (const entry of await outbox()) {
    if (entry.store === storeName) pending.set(entry.key, entry);
  }

  const db = await open();
  const transaction = db.transaction([storeName, 'outbox'], 'readwrite');
  const store = transaction.objectStore(storeName);
  const outboxStore = transaction.objectStore('outbox');
  let applied = 0;

  for (const row of rows) {
    const key = `${storeName}:${row.id}`;
    const queued = pending.get(key);
    // Do not clobber a local edit that has not been pushed yet unless the
    // server copy is genuinely newer.
    if (queued && queued.row.updated_at > row.updated_at) continue;
    if (queued) outboxStore.delete(key);
    store.put({ ...row, deleted: row.deleted ? 1 : 0 });
    applied += 1;
  }

  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  return applied;
}

/* ---------------------------------------------------------------- outbox */

export async function outbox() {
  const db = await open();
  const store = db.transaction('outbox', 'readonly').objectStore('outbox');
  return request(store.getAll());
}

export async function outboxCount() {
  const db = await open();
  const store = db.transaction('outbox', 'readonly').objectStore('outbox');
  return request(store.count());
}

export async function clearOutboxKeys(keys) {
  if (!keys.length) return;
  const db = await open();
  const transaction = db.transaction('outbox', 'readwrite');
  const store = transaction.objectStore('outbox');
  keys.forEach((key) => store.delete(key));
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

/** Wipe the local replica. Used by "reset local data" in Settings. */
export async function resetLocal() {
  const db = await open();
  const names = [...STORES, 'outbox', 'meta'];
  const transaction = db.transaction(names, 'readwrite');
  names.forEach((n) => transaction.objectStore(n).clear());
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}
