/* Pay rate engine and shared formatting helpers.
 *
 * Pure module: no DOM access at import time, so the bundled offline shell
 * can import it directly. app.js re-exports everything from here for the
 * server-rendered pages.
 */

import * as store from './store.js';

/* ------------------------------------------------------- API base URL.
 * The server-rendered site uses relative URLs (same origin). The bundled
 * app shell runs from capacitor://localhost, so it sets an absolute base.
 */
let API_BASE = '';

export function setApiBase(url) {
  API_BASE = (url || '').replace(/\/$/, '');
}

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}

/* ------------------------------------------------------- formatting */

export const money = (value) =>
  `$${(Number(value) || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

export const qtyText = (value) => {
  const n = Number(value) || 0;
  return Number.isInteger(n) ? String(n) : String(n);
};

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ------------------------------------------------------- pay rate engine */

export let RATES = {
  'R1 – Residential Installation': 70.0,
  'D8 – Drop Splice (Terminal & NID)': 15.0,
  'D7 – Place NID Housing w/ Riser': 20.0,
  'D11 – UG Temp Drop': 30.0,
  'D6 – Pull Through Existing Conduit': 0.5,
  'D5 – Sidewalk Bore': 25.0,
  'D10 – Truck Roll / Trip Fee': 25.0,
  'A1 – Hang Overhead Drop': 0.4,
  'D2 – Direct Bury Flat Drop': 0.6,
};

/* Pre-card-swap (2026-09-27) names -> current names. Jobs saved under the
 * old card still carry the old names in their items; resolving them here
 * keeps every existing job priced at the new rates. Mirrors RATE_ALIASES
 * in mercury/rates.py — change both in the same commit. */
export const RATE_ALIASES = {
  'Installation': 'R1 – Residential Installation',
  'Fusion Splice': 'D8 – Drop Splice (Terminal & NID)',
  'Place Nid w/ Riser': 'D7 – Place NID Housing w/ Riser',
  'Temp drop laid': 'D11 – UG Temp Drop',
  'Trip Fee': 'D10 – Truck Roll / Trip Fee',
  "Direct bury flat drop (0-300')": 'D2 – Direct Bury Flat Drop',
  "bore (0-12')": 'D5 – Sidewalk Bore',
  'Conduit Pull Footage': 'D6 – Pull Through Existing Conduit',
  'Aerial Drop Footage': 'A1 – Hang Overhead Drop',
};

export const FOOTAGE_ITEMS = new Set([
  'A1 – Hang Overhead Drop',
  'D2 – Direct Bury Flat Drop',
  'D6 – Pull Through Existing Conduit',
]);

export function canonicalName(name) {
  return RATE_ALIASES[name] || name;
}

// Load stored rates dynamically from local storage / bootstrap
export async function loadDynamicRates() {
  try {
    const cached = await store.meta('rate_table');
    if (cached && Array.isArray(cached)) {
      cached.forEach(r => {
        if (r.item && r.rate !== undefined) RATES[r.item] = parseFloat(r.rate);
      });
    }
    if (navigator.onLine) {
      const res = await fetch(apiUrl('/api/bootstrap'));
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

export function itemPrice(name, qty) {
  const q = Number(qty) || 0;
  if (q <= 0) return 0;
  return q * (RATES[canonicalName(name)] || 0);
}

export function jobTotal(items) {
  return Math.round(
    Object.entries(items || {}).reduce((sum, [name, qty]) => sum + itemPrice(name, qty), 0) * 100,
  ) / 100;
}
