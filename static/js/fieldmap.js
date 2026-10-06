/* Field Map — pins, routes and footage measurement on a Leaflet map. */

import { toast, buzz } from './app.js';
import { deviceId, uuid } from './store.js';
import { getNativeLocation } from './native.js';

const LS_KEY = 'mercury:fieldmaps';

const PIN_TYPES = {
  bore_start:    { label: 'Bore Start',    short: 'BS', color: '#fb923c' },
  bore_end:      { label: 'Bore End',      short: 'BE', color: '#f87171' },
  conduit_start: { label: 'Conduit Start', short: 'CS', color: '#38bdf8' },
  conduit_end:   { label: 'Conduit End',   short: 'CE', color: '#a78bfa' },
  drop:          { label: 'Drop Point',    short: 'DP', color: '#4ade80' },
  splice:        { label: 'Splice Point',  short: 'SP', color: '#facc15' },
};

const ROUTE_TYPES = {
  conduit_pull: { label: 'Conduit pull', color: '#38bdf8' },
  drop:         { label: 'Drop',         color: '#4ade80' },
  bore:         { label: 'Bore',         color: '#fb923c' },
  gps:          { label: 'GPS route',    color: '#a78bfa' },
};

const state = {
  map: null,
  pins: [],        // {id, type, lat, lng, label, marker}
  routes: [],      // {id, name, type, points:[{lat,lng}], polyline, markers}
  activeTool: null,
  drawing: null,   // route being drawn
  currentId: null, // loaded fieldmap id
  rates: null,
};

/* ------------------------------------------------------------ geometry */

function haversineFt(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s)) * 3.28084;
}

function routeFootage(points) {
  let ft = 0;
  for (let i = 1; i < points.length; i++) ft += haversineFt(points[i - 1], points[i]);
  return ft;
}


/* ------------------------------------------------------------ tile cache
   Map tiles are cached in IndexedDB (on this device) so areas Matt has
   already visited load instantly instead of re-downloading every time.
   LRU-evicted at MAX_TILES. */

const TileCache = {
  DB_NAME: 'mercury:tilecache',
  STORE: 'tiles',
  MAX_TILES: 600,
  db: null,

  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(this.DB_NAME, 1);
      } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('tiles')) {
          const s = db.createObjectStore('tiles', { keyPath: 'key' });
          s.createIndex('ts', 'ts', { unique: false });
        }
      };
      req.onsuccess = () => { TileCache.db = req.result; resolve(req.result); };
      req.onerror = () => reject(req.error);
    });
  },

  _tx(mode, fn) {
    return this.open().then((db) => new Promise((resolve, reject) => {
      try {
        const tx = db.transaction('tiles', mode);
        const req = fn(tx.objectStore('tiles'));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) { reject(e); }
    }));
  },

  get(key) {
    return this._tx('readonly', (s) => s.get(key)).then((rec) => {
      if (rec && rec.blob) {
        this._tx('readwrite', (s) => s.put({ key: key, blob: rec.blob, ts: Date.now() })).catch(() => {});
        return rec.blob;
      }
      return null;
    }).catch(() => null);
  },

  put(key, blob) {
    return this._tx('readwrite', (s) => s.put({ key: key, blob: blob, ts: Date.now() }))
      .then(() => this._evict()).catch(() => {});
  },

  _evict() {
    return this.open().then((db) => new Promise((resolve) => {
      try {
        const tx = db.transaction('tiles', 'readwrite');
        const store = tx.objectStore('tiles');
        const countReq = store.count();
        countReq.onsuccess = () => {
          const over = countReq.result - TileCache.MAX_TILES;
          if (over <= 0) { resolve(); return; }
          let deleted = 0;
          store.index('ts').openCursor().onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor && deleted < over) {
              cursor.delete(); deleted++; cursor.continue();
            } else resolve();
          };
        };
        countReq.onerror = () => resolve();
      } catch (e) { resolve(); }
    }));
  },
};

function tileCacheKey(url) {
  const m = url.match(/\/(\d+)\/(\d+)\/(\d+)(?:\.\w+)?(?:\?.*)?$/);
  if (m) {
    const h = url.match(/^https?:\/\/([^/]+)/);
    return (h ? h[1] : 'tiles') + '/' + m[1] + '/' + m[2] + '/' + m[3];
  }
  return url;
}

const CachedTileLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const tile = document.createElement('img');
    L.DomUtil.addClass(tile, 'leaflet-tile');
    tile.alt = '';
    tile.setAttribute('role', 'presentation');
    if (this.options.crossOrigin) tile.crossOrigin = 'anonymous';

    const url = this.getTileUrl(coords);
    const key = tileCacheKey(url);

    const finishFromBlob = (blob) => {
      const objUrl = URL.createObjectURL(blob);
      tile._objectUrl = objUrl;
      tile.onload = () => done(null, tile);
      tile.onerror = () => done(new Error('tile decode failed'), tile);
      tile.src = objUrl;
    };

    TileCache.get(key).then((blob) => {
      if (blob) {
        finishFromBlob(blob);
      } else {
        fetch(url, { mode: 'cors', credentials: 'omit' }).then((r) => {
          if (!r.ok) throw new Error('tile http ' + r.status);
          return r.blob();
        }).then((blob) => {
          TileCache.put(key, blob);
          finishFromBlob(blob);
        }).catch(() => {
          tile.onload = () => done(null, tile);
          tile.onerror = () => done(new Error('tile load failed'), tile);
          tile.src = url;
        });
      }
    });
    return tile;
  },

  _removeTile(key) {
    const t = this._tiles && this._tiles[key];
    if (t && t.el && t.el._objectUrl) {
      try { URL.revokeObjectURL(t.el._objectUrl); } catch (e) {}
      t.el._objectUrl = null;
    }
    L.TileLayer.prototype._removeTile.call(this, key);
  },
});

/* ------------------------------------------------------------ map init */


function initMap() {
  const el = document.getElementById('fm-map');
  if (typeof L === 'undefined') {
    el.classList.add('offline');
    el.innerHTML =
      '<div><div style="font-size:30px">🛰</div>' +
      '<h3>Map needs a connection</h3>' +
      '<p>The map library could not load.<br>Your saved maps are still listed below.</p></div>';
    return false;
  }
  const osm = new CachedTileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap contributors',
  });
  const sat = new CachedTileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: '© Esri World Imagery' },
  );
  const map = L.map('fm-map', { layers: [sat], zoomControl: true, keepBuffer: 1, updateWhenIdle: true });
  // Default to the home operating area (NE Indiana); re-centered on load
  // when a saved map or GPS fix is available.
  map.setView([41.64, -85.42], 13);
  L.control.layers({ Satellite: sat, Streets: osm }).addTo(map);
  map.on('click', onMapClick);
  map.on('dblclick', finishDrawing);
  state.map = map;
  const resync = () => { try { map.invalidateSize(); } catch (e) {} };
  setTimeout(resync, 120);
  setTimeout(resync, 600);
  window.addEventListener('resize', resync);
  window.addEventListener('orientationchange', function() { setTimeout(resync, 300); });
  return true;
}

function pinIcon(type) {
  const cfg = PIN_TYPES[type] || PIN_TYPES.drop;
  return L.divIcon({
    className: '',
    html: `<div class="fm-pin" style="background:${cfg.color}">${cfg.short}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

/* ------------------------------------------------------------ tools */

const toolbar = document.getElementById('fm-toolbar');

function setTool(tool) {
  if (state.drawing) finishDrawing();
  state.activeTool = state.activeTool === tool ? null : tool;
  for (const btn of toolbar.querySelectorAll('[data-tool]')) {
    btn.classList.toggle('active', btn.dataset.tool === state.activeTool);
  }
  if (state.activeTool && state.activeTool.startsWith('route_')) {
    startDrawing(state.activeTool.slice(6));
  }
  const mapEl = document.getElementById('fm-map');
  mapEl.style.cursor = state.activeTool ? 'crosshair' : '';
}

toolbar.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-tool]');
  if (!btn) return;
  if (!state.map) { toast('Map is still loading - try again in a second.', 'warning'); return; }
  buzz();
  setTool(btn.dataset.tool);
});

function onMapClick(event) {
  if (!state.activeTool) return;
  const { lat, lng } = event.latlng;
  if (state.activeTool.startsWith('route_')) {
    addWaypoint({ lat, lng });
  } else {
    addPin(state.activeTool, lat, lng);
  }
  buzz(8);
}

/* ------------------------------------------------------------ pins */

function addPin(type, lat, lng, label = '', id = null) {
  const cfg = PIN_TYPES[type] || PIN_TYPES.drop;
  const pin = { id: id || uuid(), type, lat, lng, label: label || cfg.label };
  pin.marker = L.marker([lat, lng], { icon: pinIcon(type), draggable: true })
    .addTo(state.map)
    .bindPopup(
      `<b>${cfg.label}</b><br>` +
      `<input id="fm-pin-label" value="${escapeHtml(pin.label)}" ` +
      `style="width:150px;margin:6px 0" placeholder="Label"><br>` +
      `<button id="fm-pin-save" style="margin-right:8px">Save</button>` +
      `<button id="fm-pin-del" style="color:#f87171">Delete</button>`,
    );
  pin.marker.on('popupopen', () => {
    document.getElementById('fm-pin-save')?.addEventListener('click', () => {
      const input = document.getElementById('fm-pin-label');
      pin.label = input.value.trim() || cfg.label;
      pin.marker.closePopup();
      refreshTotals();
    });
    document.getElementById('fm-pin-del')?.addEventListener('click', () => {
      removePin(pin.id);
    });
  });
  pin.marker.on('dragend', () => {
    const p = pin.marker.getLatLng();
    pin.lat = p.lat;
    pin.lng = p.lng;
  });
  state.pins.push(pin);
  refreshTotals();
  return pin;
}

function removePin(id) {
  const i = state.pins.findIndex((p) => p.id === id);
  if (i >= 0) {
    state.map.removeLayer(state.pins[i].marker);
    state.pins.splice(i, 1);
    refreshTotals();
  }
}

/* ------------------------------------------------------------ routes */

function startDrawing(type) {
  const cfg = ROUTE_TYPES[type] || ROUTE_TYPES.conduit_pull;
  const n = state.routes.filter((r) => r.type === type).length + 1;
  const route = {
    id: uuid(),
    name: `${cfg.label} ${n}`,
    type,
    points: [],
    polyline: L.polyline([], { color: cfg.color, weight: 4 }).addTo(state.map),
  };
  state.routes.push(route);
  state.drawing = route;
  toast(`Tap the map to trace — double-tap to finish ${cfg.label.toLowerCase()}.`, 'info');
}

function addWaypoint(latlng) {
  const route = state.drawing;
  if (!route) return;
  route.points.push({ lat: latlng.lat, lng: latlng.lng });
  route.polyline.setLatLngs(route.points.map((p) => [p.lat, p.lng]));
  L.circleMarker([latlng.lat, latlng.lng], {
    radius: 4, color: ROUTE_TYPES[route.type].color, fillOpacity: 1,
  }).addTo(state.map);
  refreshTotals();
}

function finishDrawing() {
  if (!state.drawing) return;
  const route = state.drawing;
  state.drawing = null;
  if (route.points.length < 2) {
    state.map.removeLayer(route.polyline);
    state.routes = state.routes.filter((r) => r !== route);
  } else {
    toast(`${route.name}: ${Math.round(routeFootage(route.points))} ft`, 'success');
  }
  setTool(null);
  refreshTotals();
}

function removeRoute(id) {
  const i = state.routes.findIndex((r) => r.id === id);
  if (i >= 0) {
    state.map.removeLayer(state.routes[i].polyline);
    state.routes.splice(i, 1);
    refreshTotals();
  }
}

/* ------------------------------------------------------------ totals */

function totals() {
  const t = { conduit: 0, drop: 0, bore: 0, gps: 0 };
  for (const r of state.routes) {
    const ft = routeFootage(r.points);
    if (r.type === 'conduit_pull') t.conduit += ft;
    else if (r.type === 'drop') t.drop += ft;
    else if (r.type === 'bore') t.bore += ft;
    else t.gps += ft;
  }
  t.bores = state.pins.filter((p) => p.type === 'bore_start').length;
  t.splices = state.pins.filter((p) => p.type === 'splice').length;
  return t;
}

function refreshTotals() {
  const t = totals();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = Math.round(v); };
  set('fm-t-conduit', t.conduit);
  set('fm-t-drop', t.drop);
  set('fm-t-bore', t.bore);
  set('fm-t-gps', t.gps);
  set('fm-t-bores', t.bores);
  set('fm-t-splices', t.splices);

  const host = document.getElementById('fm-routes');
  host.innerHTML = '';
  for (const r of state.routes) {
    const cfg = ROUTE_TYPES[r.type];
    const row = document.createElement('div');
    row.className = 'fm-route-row';
    row.innerHTML =
      `<span class="fm-swatch" style="background:${cfg.color}"></span>` +
      `<span class="grow">${escapeHtml(r.name)} <span style="color:var(--text-mute)">· ${r.points.length} pts</span></span>` +
      `<span class="ft">${Math.round(routeFootage(r.points))} ft</span>`;
    const del = document.createElement('button');
    del.className = 'fm-del';
    del.textContent = '✕';
    del.setAttribute('aria-label', `Delete ${r.name}`);
    del.addEventListener('click', () => removeRoute(r.id));
    row.appendChild(del);
    host.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ------------------------------------------------------------ search + GPS */

let searchTimer = null;
const searchInput = document.getElementById('fm-search');
const resultsBox = document.getElementById('fm-results');

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 3) { resultsBox.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`,
        { headers: { Accept: 'application/json' } },
      );
      const items = await res.json();
      resultsBox.innerHTML = '';
      if (!items.length) {
        resultsBox.hidden = true;
        return;
      }
      for (const it of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = it.display_name;
        b.addEventListener('click', () => {
          state.map.flyTo([Number(it.lat), Number(it.lon)], 17);
          resultsBox.hidden = true;
          searchInput.value = it.display_name.split(',')[0];
          buzz();
        });
        resultsBox.appendChild(b);
      }
      resultsBox.hidden = false;
    } catch {
      toast('Address search needs a connection.', 'warning');
    }
  }, 450);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.fm-results') && e.target !== searchInput) {
    resultsBox.hidden = true;
  }
});

document.getElementById('fm-locate').addEventListener('click', async () => {
  if (!state.map) return;
  toast('Getting your location…', 'info');
  try {
    let lat, lng;
    try {
      const fix = await getNativeLocation();
      lat = fix.latitude; lng = fix.longitude;
    } catch {
      const pos = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true, timeout: 15000, maximumAge: 0,
        }));
      lat = pos.coords.latitude; lng = pos.coords.longitude;
    }
    state.map.flyTo([lat, lng], 17);
    L.circleMarker([lat, lng], {
      radius: 8, color: '#38bdf8', fillColor: '#38bdf8', fillOpacity: 0.8,
    }).addTo(state.map).bindPopup('You are here').openPopup();
    buzz([12, 40, 12]);
  } catch {
    toast('Could not get a location fix.', 'warning');
  }
});

/* ------------------------------------------------------------ persistence */

function serialize() {
  return {
    pins: state.pins.map((p) => ({ id: p.id, type: p.type, lat: p.lat, lng: p.lng, label: p.label })),
    routes: state.routes.map((r) => ({
      id: r.id, name: r.name, type: r.type,
      points: r.points.map((p) => ({ lat: p.lat, lng: p.lng })),
    })),
  };
}

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeLocal(list) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    /* storage full — server copy still attempted */
  }
}

async function apiHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  try {
    headers['X-Device-Id'] = await deviceId();
  } catch {
    /* offline-safe */
  }
  return headers;
}

async function loadSaved() {
  let list = readLocal();
  try {
    const res = await fetch('/api/fieldmaps');
    if (res.ok) {
      const { fieldmaps = [] } = await res.json();
      // Union by id, newest updated_at wins.
      const byId = new Map(list.map((m) => [m.id, m]));
      for (const fm of fieldmaps) {
        const local = byId.get(fm.id);
        if (!local || (fm.updated_at || '') >= (local.updated_at || '')) {
          byId.set(fm.id, fm);
        }
      }
      list = [...byId.values()].sort((a, b) =>
        String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
      writeLocal(list);
    }
  } catch {
    /* offline — local list stands */
  }
  renderSaved(list);
  return list;
}

function renderSaved(list) {
  const host = document.getElementById('fm-saved');
  host.innerHTML = '';
  if (!list.length) {
    host.innerHTML = '<div class="empty" style="padding:20px"><p>No saved maps yet.</p></div>';
    return;
  }
  for (const fm of list) {
    const data = fm.data || {};
    const np = (data.pins || []).length;
    const nr = (data.routes || []).length;
    const row = document.createElement('div');
    row.className = 'fm-saved-row';
    const when = (fm.updated_at || '').slice(0, 10);
    row.innerHTML =
      `<div class="grow"><div class="name">${escapeHtml(fm.name || 'Untitled map')}</div>` +
      `<div class="meta">${np} pins · ${nr} routes · ${when}</div></div>`;
    const load = document.createElement('button');
    load.className = 'btn btn-outline';
    load.textContent = 'Open';
    load.addEventListener('click', () => openMap(fm));
    const del = document.createElement('button');
    del.className = 'fm-del';
    del.textContent = '✕';
    del.setAttribute('aria-label', `Delete ${fm.name}`);
    del.addEventListener('click', async () => {
      if (!confirm(`Delete "${fm.name || 'Untitled map'}"?`)) return;
      const next = readLocal().filter((m) => m.id !== fm.id);
      writeLocal(next);
      try {
        await fetch(`/api/fieldmaps/${fm.id}`, {
          method: 'DELETE', headers: await apiHeaders(),
        });
      } catch { /* offline — local delete stands */ }
      if (state.currentId === fm.id) {
        state.currentId = null;
        document.getElementById('fm-name').value = '';
        document.getElementById('fm-notes').value = '';
      }
      loadSaved();
      toast('Map deleted.', 'success');
    });
    row.appendChild(load);
    row.appendChild(del);
    host.appendChild(row);
  }
}

function clearMap() {
  if (state.map) {
    for (const p of state.pins) state.map.removeLayer(p.marker);
    for (const r of state.routes) state.map.removeLayer(r.polyline);
  }
  state.pins = [];
  state.routes = [];
  state.drawing = null;
  refreshTotals();
}

function openMap(fm) {
  if (!state.map) {
    toast('Map needs a connection to display.', 'warning');
    return;
  }
  clearMap();
  state.currentId = fm.id;
  document.getElementById('fm-name').value = fm.name || '';
  document.getElementById('fm-notes').value = fm.notes || '';
  const data = fm.data || {};
  const bounds = [];
  for (const p of data.pins || []) {
    addPin(p.type, p.lat, p.lng, p.label, p.id);
    bounds.push([p.lat, p.lng]);
  }
  for (const r of data.routes || []) {
    const cfg = ROUTE_TYPES[r.type] || ROUTE_TYPES.conduit_pull;
    const route = {
      id: r.id || uuid(), name: r.name || cfg.label, type: r.type || 'conduit_pull',
      points: (r.points || []).map((p) => ({ lat: p.lat, lng: p.lng })),
      polyline: L.polyline((r.points || []).map((p) => [p.lat, p.lng]),
        { color: cfg.color, weight: 4 }).addTo(state.map),
    };
    state.routes.push(route);
    for (const p of route.points) bounds.push([p.lat, p.lng]);
  }
  if (bounds.length) state.map.fitBounds(bounds, { padding: [30, 30] });
  refreshTotals();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast(`Opened "${fm.name || 'Untitled map'}".`, 'success');
}

document.getElementById('fm-save').addEventListener('click', async () => {
  const name = document.getElementById('fm-name').value.trim() || 'Untitled map';
  const notes = document.getElementById('fm-notes').value.trim();
  const now = new Date().toISOString();
  const fm = {
    id: state.currentId || uuid(),
    name, notes,
    data: serialize(),
    updated_at: now,
  };
  const list = readLocal().filter((m) => m.id !== fm.id);
  list.unshift(fm);
  writeLocal(list);
  state.currentId = fm.id;
  document.getElementById('fm-name').value = name;
  try {
    const res = await fetch('/api/fieldmaps', {
      method: 'POST', headers: await apiHeaders(), body: JSON.stringify(fm),
    });
    const body = await res.json();
    if (body.ok && body.fieldmap) {
      const merged = readLocal().map((m) => (m.id === fm.id ? body.fieldmap : m));
      writeLocal(merged);
    }
    toast(navigator.onLine ? 'Map saved.' : 'Saved on this device — will sync when online.', 'success');
  } catch {
    toast('Saved on this device (offline).', 'warning');
  }
  buzz([12, 40, 12]);
  loadSaved();
});

document.getElementById('fm-clear').addEventListener('click', () => {
  if (!confirm('Clear all pins and routes from this map?')) return;
  clearMap();
  state.currentId = null;
  document.getElementById('fm-name').value = '';
  document.getElementById('fm-notes').value = '';
});

/* ------------------------------------------------------------ send to job */

async function getRates() {
  if (state.rates) return state.rates;
  try {
    const res = await fetch('/api/rates');
    const body = await res.json();
    state.rates = (body.rates || []).map((r) => r.item);
  } catch {
    state.rates = [
      'D6 – Pull Through Existing Conduit',
      'D5 – Sidewalk Bore',
      'D8 – Drop Splice (Terminal & NID)',
      'D2 – Direct Bury Flat Drop',
    ];
  }
  return state.rates;
}

document.getElementById('fm-send-job').addEventListener('click', async () => {
  const t = totals();
  const rates = await getRates();
  const find = (kw) => rates.find((n) => n.toLowerCase().includes(kw));
  const items = {};
  const conduitFt = Math.round(t.conduit);
  const dropFt = Math.round(t.drop);
  if (conduitFt > 0) {
    const name = find('conduit');
    if (name) items[name] = conduitFt;
  }
  if (dropFt > 0) {
    const name = find('flat drop');
    if (name) items[name] = dropFt;
  }
  if (t.bores > 0) {
    const name = find('bore');
    if (name) items[name] = t.bores;
  }
  if (t.splices > 0) {
    const name = find('splice');
    if (name) items[name] = t.splices;
  }
  if (!Object.keys(items).length) {
    toast('Nothing to send — trace a route or drop pins first.', 'warning');
    return;
  }
  const name = document.getElementById('fm-name').value.trim();
  sessionStorage.setItem('mercury:job-prefill', JSON.stringify({
    address: name || '',
    notes: `From field map "${name || 'Untitled map'}".`,
    items,
  }));
  location.href = '/jobs/new';
});

/* ------------------------------------------------------------ export */

function download(filename, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 30000);
}

document.getElementById('fm-export-json').addEventListener('click', () => {
  const t = totals();
  const name = document.getElementById('fm-name').value.trim() || 'Untitled map';
  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    name,
    notes: document.getElementById('fm-notes').value.trim(),
    pins: serialize().pins,
    routes: serialize().routes.map((r) => ({
      ...r, footageFt: Math.round(routeFootage(r.points)),
    })),
    measurements: {
      conduitPullFeet: Math.round(t.conduit),
      dropFeet: Math.round(t.drop),
      boreFeet: Math.round(t.bore),
      gpsFeet: Math.round(t.gps),
      boreCount: t.bores,
      spliceCount: t.splices,
    },
  };
  const id8 = (state.currentId || uuid()).slice(0, 8);
  download(`fieldmap-${id8}.json`,
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  toast('Field map exported as JSON.', 'success');
});

document.getElementById('fm-export-png').addEventListener('click', async () => {
  if (!state.map) {
    toast('Map needs a connection to render an image.', 'warning');
    return;
  }
  if (typeof html2canvas === 'undefined') {
    toast('Image export library did not load — check your connection.', 'warning');
    return;
  }
  toast('Rendering map image…', 'info');
  try {
    const canvas = await html2canvas(document.getElementById('fm-map'), {
      useCORS: true, backgroundColor: '#0B1120', logging: false,
    });
    const id8 = (state.currentId || uuid()).slice(0, 8);
    canvas.toBlob((blob) => {
      if (blob) {
        download(`fieldmap-${id8}.png`, blob);
        toast('Map image exported.', 'success');
      } else {
        toast('Could not render the image.', 'danger');
      }
    }, 'image/png');
  } catch {
    toast('Image export failed — tile servers may block it offline.', 'danger');
  }
});

/* ------------------------------------------------------------ boot */

let _booted = false;
function boot() {
  if (_booted) return;
  _booted = true;
  if (initMap()) {
    loadSaved();
    refreshTotals();
  } else {
    loadSaved();
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
