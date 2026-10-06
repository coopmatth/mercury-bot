/* Mercury Field Map — RIC-style measure workflow, Mercury dark theme.
   Clean-room implementation: no RIC code or branding. */

import { toast, buzz } from './app.js';
import { deviceId, uuid } from './store.js';
import { getNativeLocation, savePhotos } from './native.js';

/* ------------------------------------------------------------ measure types */

const TYPES = {
  aerial:  { label: 'Aerial',       color: '#38bdf8', dash: null,        rate: 'overhead' },
  burial:  { label: 'Burial',       color: '#fb923c', dash: '2 6',       rate: 'bury' },
  bore:    { label: 'Bore',         color: '#c084fc', dash: null,        rate: 'bore' },
  conduit: { label: 'Conduit Pull', color: '#4ade80', dash: '1 5',       rate: 'conduit' },
  strand:  { label: 'Strand',       color: '#f472b6', dash: '6 3',       rate: null },
  lashing: { label: 'Lashing',      color: '#facc15', dash: '8 4 2 4',   rate: null },
};
const TYPE_ORDER = ['aerial', 'burial', 'bore', 'conduit', 'strand', 'lashing'];

/* ---------------- Custom measurement types ---------------- */
const CUSTOM_KEY = 'mercury:fieldmap:custom-types';
let customDash = null; // null = solid, '1 6' = dots

function loadCustomTypes() {
  try {
    const saved = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
    for (const c of saved) {
      if (c && c.id && c.label && !TYPES[c.id]) {
        TYPES[c.id] = { label: c.label, color: c.color || '#f97316', dash: c.dash || null, rate: null, custom: true };
        if (!TYPE_ORDER.includes(c.id)) TYPE_ORDER.push(c.id);
      }
    }
  } catch (e) { /* ignore */ }
}

function saveCustomTypes() {
  try {
    const customs = TYPE_ORDER.filter(k => TYPES[k] && TYPES[k].custom)
      .map(k => ({ id: k, label: TYPES[k].label, color: TYPES[k].color, dash: TYPES[k].dash }));
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(customs));
  } catch (e) { /* ignore */ }
}

const CUSTOM_SWATCHES = ['#f97316', '#ef4444', '#ec4899', '#a855f7', '#8b5cf6', '#3b82f6', '#06b6d4', '#10b981', '#84cc16', '#eab308', '#facc15', '#ffffff'];

function openCustomPanel() {
  document.getElementById('fm-custom-overlay').hidden = false;
  document.getElementById('fm-custom-name').value = '';
  customDash = null;
  updateCustomStyleBtns();
  const sw = document.getElementById('fm-custom-swatches');
  sw.innerHTML = '';
  for (const c of CUSTOM_SWATCHES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.cssText = 'width:32px;height:32px;border-radius:8px;border:2px solid transparent;background:' + c + ';cursor:pointer;';
    b.addEventListener('click', () => {
      document.getElementById('fm-custom-color').value = c;
      [...sw.children].forEach(x => x.style.borderColor = 'transparent');
      b.style.borderColor = '#fff';
      buzz(5);
    });
    sw.appendChild(b);
  }
  buzz(8);
}

function updateCustomStyleBtns() {
  const s = document.getElementById('fm-custom-solid');
  const d = document.getElementById('fm-custom-dots');
  s.classList.toggle('primary', customDash === null);
  d.classList.toggle('primary', customDash !== null);
}

function createCustomType() {
  const name = (document.getElementById('fm-custom-name').value || '').trim();
  if (!name) { toast('Enter a name for the custom type', 'warn'); return; }
  const color = document.getElementById('fm-custom-color').value || '#f97316';
  const id = 'custom-' + Date.now().toString(36);
  TYPES[id] = { label: name, color, dash: customDash, rate: null, custom: true };
  TYPE_ORDER.push(id);
  saveCustomTypes();
  document.getElementById('fm-custom-overlay').hidden = true;
  state.activeType = id;
  renderTypes();
  toast('"' + name + '" created', 'ok');
  buzz(15);
}

function initCustomPanel() {
  document.getElementById('fm-custom-close').addEventListener('click', () => {
    document.getElementById('fm-custom-overlay').hidden = true;
  });
  document.getElementById('fm-custom-solid').addEventListener('click', () => {
    customDash = null; updateCustomStyleBtns(); buzz(5);
  });
  document.getElementById('fm-custom-dots').addEventListener('click', () => {
    customDash = '1 6'; updateCustomStyleBtns(); buzz(5);
  });
  document.getElementById('fm-custom-create').addEventListener('click', createCustomType);
}


/* Mercury rate-card mapping (see 2026-10-03 9-item card) */
const RATE_MAP = {
  aerial:  { name: 'Hang Overhead Drop',        unit: 'ft',  price: 0.40 },
  burial:  { name: 'Direct Bury Flat Drop',     unit: 'ft',  price: 0.60 },
  bore:    { name: 'Sidewalk Bore',             unit: 'each', price: 25 },
  conduit: { name: 'Pull Through Existing Conduit', unit: 'ft', price: 0.50 },
};

const LS_KEY = 'mercury:fieldmaps:v2';

const state = {
  map: null,
  layers: {},
  activeType: 'aerial',
  measuring: false,
  points: [],       // {id, n, type, lat, lng, label, ts, segFt}
  routeLines: [],   // leaflet polylines
  routeMarkers: [],
  gpsMarker: null,
  gpsAcc: null,
  currentId: null,
  savedMaps: [],
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

function typeTotals() {
  const t = {};
  for (const k of TYPE_ORDER) t[k] = 0;
  for (let i = 1; i < state.points.length; i++) {
    const p = state.points[i];
    t[p.type] = (t[p.type] || 0) + haversineFt(state.points[i - 1], p);
  }
  return t;
}
function grandTotal() {
  return Object.values(typeTotals()).reduce((a, b) => a + b, 0);
}

/* ------------------------------------------------------------ tile cache (IndexedDB) */

const TileCache = {
  DB_NAME: 'mercury:tilecache',
  MAX_TILES: 600,
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(this.DB_NAME, 1); }
      catch (e) { reject(e); return; }
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
        this._tx('readwrite', (s) => s.put({ key, blob: rec.blob, ts: Date.now() })).catch(() => {});
        return rec.blob;
      }
      return null;
    }).catch(() => null);
  },
  put(key, blob) {
    return this._tx('readwrite', (s) => s.put({ key, blob, ts: Date.now() }))
      .then(() => this._evict()).catch(() => {});
  },
  _evict() {
    return this.open().then((db) => new Promise((resolve) => {
      try {
        const tx = db.transaction('tiles', 'readwrite');
        const store = tx.objectStore('tiles');
        const cr = store.count();
        cr.onsuccess = () => {
          const over = cr.result - TileCache.MAX_TILES;
          if (over <= 0) { resolve(); return; }
          let n = 0;
          store.index('ts').openCursor().onsuccess = (e) => {
            const c = e.target.result;
            if (c && n < over) { c.delete(); n++; c.continue(); }
            else resolve();
          };
        };
        cr.onerror = () => resolve();
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
    const url = this.getTileUrl(coords);
    tile._tileUrl = url;
    tile.setAttribute('data-tile-url', url);
    const key = tileCacheKey(url);
    const directLoad = () => {
      tile.onload = () => done(null, tile);
      tile.onerror = () => done(new Error('tile load'), tile);
      tile.src = url;
    };
    const show = (blob) => {
      try {
        const ou = URL.createObjectURL(blob);
        tile._objectUrl = ou;
        tile.onload = () => done(null, tile);
        tile.onerror = directLoad;
        tile.src = ou;
      } catch (e) { directLoad(); }
    };
    const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
    // Cache lookup must never hang the tile — race against 1.2s
    Promise.race([TileCache.get(key), timeout(1200)]).then((blob) => {
      if (blob) { show(blob); return; }
      // Fetch+cache, race against 8s, fall back to direct img on any failure
      Promise.race([
        fetch(url, { mode: 'cors', credentials: 'omit' }).then((r) => {
          if (!r.ok) throw new Error('http ' + r.status);
          return r.blob();
        }),
        timeout(8000),
      ]).then((blob) => {
        TileCache.put(key, blob).catch(() => {});
        show(blob);
      }).catch(directLoad);
    }).catch(directLoad);
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
  if (typeof L === 'undefined') {
    document.getElementById('fm-map').innerHTML =
      '<div style="display:grid;place-items:center;height:100%;color:#9fb2d1;text-align:center;padding:24px">' +
      '<div><div style="font-size:30px">🛰</div><h3>Map needs a connection</h3>' +
      '<p>The map library could not load.</p></div></div>';
    return false;
  }
  const sat = new CachedTileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: '© Esri World Imagery' }
  );
  const osm = new CachedTileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '© OpenStreetMap contributors' }
  );
  const map = L.map('fm-map', {
    layers: [sat], zoomControl: false, keepBuffer: 1,
    updateWhenIdle: true, worldCopyJump: true,
  });
  map.setView([41.64, -85.42], 16);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.layers({ Satellite: sat, Streets: osm }, null, { position: 'topright' }).addTo(map);
  state.map = map;
  state.layers = { sat, osm };

  const resync = () => { try { map.invalidateSize(); } catch (e) {} };
  setTimeout(resync, 120);
  setTimeout(resync, 600);
  setTimeout(resync, 1500);
  window.addEventListener('resize', resync);
  window.addEventListener('orientationchange', () => setTimeout(resync, 300));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(resync, 200); });
  try { new ResizeObserver(() => resync()).observe(document.getElementById('fm-map')); } catch (e) {}
  map.on('moveend zoomend', updateScale);
  map.on('click', (e) => { if (state.measuring) addPointAt(e.latlng.lat, e.latlng.lng); });
  updateScale();
  return true;
}

function updateScale() {
  const map = state.map;
  if (!map) return;
  const el = document.getElementById('fm-scale');
  // feet per pixel at current zoom/lat
  const lat = map.getCenter().lat;
  const z = map.getZoom();
  const ftPerPx = (156543.03392 * Math.cos((lat * Math.PI) / 180) * 3.28084) / Math.pow(2, z);
  const target = 80; // px
  const raw = ftPerPx * target;
  const nice = [10, 20, 50, 100, 200, 300, 500, 1000, 2000].reduce((a, b) =>
    Math.abs(b - raw) < Math.abs(a - raw) ? b : a);
  el.textContent = nice >= 1000 ? (nice / 1000) + 'k ft' : nice + ' ft';
}

/* ------------------------------------------------------------ type pills */

function renderTypes() {
  const host = document.getElementById('fm-types');
  host.innerHTML = '';
  for (const key of TYPE_ORDER) {
    const t = TYPES[key];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fm-type' + (state.activeType === key ? ' active' : '');
    b.dataset.type = key;
    b.innerHTML = (state.activeType === key ? '✓ ' : '') + t.label.toUpperCase();
    b.addEventListener('click', () => {
      state.activeType = key;
      buzz(8);
      renderTypes();
    });
    host.appendChild(b);
  }
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'fm-type';
  more.textContent = '... MORE';
  more.addEventListener('click', openCustomPanel);
  host.appendChild(more);
}

/* ------------------------------------------------------------ GPS */

async function locate(center = true) {
  const accEl = document.getElementById('fm-acc');
  const gpsEl = document.getElementById('fm-gpsacc');
  try {
    const pos = await getNativeLocation({ timeout: 15000 });
    const { lat, lng, accuracy } = pos;
    state.gpsAcc = accuracy;
    const ft = accuracy ? Math.round(accuracy * 3.28084) : null;
    accEl.textContent = ft ? '±' + ft + ' ft' : 'GPS';
    gpsEl.textContent = ft ? 'GPS ±' + ft + ' ft' : '';
    if (state.gpsMarker) state.gpsMarker.remove();
    state.gpsMarker = L.circleMarker([lat, lng], {
      radius: 8, color: '#fff', weight: 2, fillColor: '#2f7bff', fillOpacity: 1,
    }).addTo(state.map);
    if (center) state.map.setView([lat, lng], Math.max(state.map.getZoom(), 17));
    return pos;
  } catch (e) {
    toast('Could not get GPS fix.', 'warning');
    return null;
  }
}

/* ------------------------------------------------------------ measure workflow */

function setMeasuring(on) {
  state.measuring = on;
  document.getElementById('fm-start').hidden = on;
  document.getElementById('fm-measuring').hidden = !on;
  document.getElementById('fm-crosshair').classList.toggle('on', on);
  document.getElementById('fm-pointbar').hidden = !on || state.points.length === 0;
  if (on) {
    state.points = [];
    clearRoute();
    refreshTotals();
    toast('Pan the map, then tap Add point.', 'info');
  }
}

function mapCenter() {
  const map = state.map;
  try {
    const r = document.getElementById('fm-map').getBoundingClientRect();
    const s = map.getSize();
    if (Math.abs(s.x - r.width) > 2 || Math.abs(s.y - r.height) > 2) map.invalidateSize();
  } catch (e) {}
  const c = map.getCenter();
  return { lat: c.lat, lng: c.lng };
}

function addPoint() {
  if (!state.measuring || !state.map) return;
  const { lat, lng } = mapCenter();
  const n = state.points.length + 1;
  const prev = state.points[state.points.length - 1];
  const segFt = prev ? haversineFt(prev, { lat, lng }) : 0;
  const pt = {
    id: uuid(), n, type: state.activeType,
    lat, lng, label: '', ts: Date.now(), segFt,
  };
  state.points.push(pt);
  drawRoute();
  refreshTotals();
  updatePointBar();
  buzz(12);
  toast('Point ' + n + ' added (' + (TYPES[pt.type] ? TYPES[pt.type].label : '') + ')', 'info');
}

// allow tapping the map directly to drop a point at the tap location
function addPointAt(lat, lng) {
  if (!state.measuring || !state.map) return;
  const n = state.points.length + 1;
  const prev = state.points[state.points.length - 1];
  const segFt = prev ? haversineFt(prev, { lat, lng }) : 0;
  const pt = { id: uuid(), n, type: state.activeType, lat, lng, label: '', ts: Date.now(), segFt };
  state.points.push(pt);
  drawRoute();
  refreshTotals();
  updatePointBar();
  buzz(12);
}

function undoPoint() {
  if (!state.points.length) return;
  state.points.pop();
  state.points.forEach((p, i) => { p.n = i + 1; });
  // recompute segment footage
  state.points.forEach((p, i) => {
    p.segFt = i === 0 ? 0 : haversineFt(state.points[i - 1], p);
  });
  drawRoute();
  refreshTotals();
  updatePointBar();
  buzz(8);
}

function drawRoute() {
  for (const l of state.routeLines) { try { l.remove(); } catch (e) {} }
  for (const m of state.routeMarkers) { try { m.remove(); } catch (e) {} }
  state.routeLines = [];
  state.routeMarkers = [];
  if (!state.map || !state.points.length) return;
  // segments: one polyline per point-pair, colored by the segment type
  for (let i = 1; i < state.points.length; i++) {
    const a = state.points[i - 1], b = state.points[i];
    const t = TYPES[b.type] || TYPES.aerial;
    try {
      state.routeLines.push(
        L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {
          color: t.color, weight: 6, opacity: 1,
          dashArray: t.dash || undefined, lineCap: 'round', lineJoin: 'round',
        }).addTo(state.map)
      );
    } catch (e) {}
  }
  // points: big visible dots with white halo
  for (const p of state.points) {
    const t = TYPES[p.type] || TYPES.aerial;
    try {
      const halo = L.circleMarker([p.lat, p.lng], {
        radius: 11, color: t.color, weight: 4, fillOpacity: 0, interactive: false,
      }).addTo(state.map);
      const dot = L.circleMarker([p.lat, p.lng], {
        radius: 7, color: '#ffffff', weight: 3, fillColor: t.color, fillOpacity: 1,
      }).addTo(state.map);
      state.routeMarkers.push(halo, dot);
    } catch (e) {}
  }
}

function clearRoute() {
  for (const l of state.routeLines) l.remove();
  for (const m of state.routeMarkers) m.remove();
  state.routeLines = [];
  state.routeMarkers = [];
}

function refreshTotals() {
  const t = grandTotal();
  document.getElementById('fm-total').textContent = t.toFixed(1) + ' ft';
}

function updatePointBar() {
  const bar = document.getElementById('fm-pointbar');
  const lbl = document.getElementById('fm-point-label');
  const p = state.points[state.points.length - 1];
  if (!p) { bar.hidden = true; return; }
  bar.hidden = false;
  const t = TYPES[p.type];
  lbl.innerHTML = 'POINT ' + p.n + ' · ' + (p.label || 'UNLABELED') +
    '<small>' + t.label + (p.segFt ? ' · ' + p.segFt.toFixed(1) + ' ft' : ' · Route start') + '</small>';
}

/* ------------------------------------------------------------ finish → summary */

function finishRoute() {
  if (state.points.length < 2) {
    toast('Add at least 2 points first.', 'warning');
    return;
  }
  setMeasuring(false);
  document.getElementById('fm-crosshair').classList.remove('on');
  showSummary();
}

function showSummary() {
  const ov = document.getElementById('fm-summary-overlay');
  const tots = typeTotals();
  const grand = grandTotal();
  document.getElementById('fm-sum-sub').textContent =
    'ROUTE COMPLETE · SAVED ON THIS DEVICE · ' +
    new Date().toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).toUpperCase();

  // totals grid
  const grid = document.getElementById('fm-sum-tots');
  grid.innerHTML = '';
  const addTot = (label, val, color, total) => {
    const d = document.createElement('div');
    d.className = 'fm-tot' + (total ? ' total' : '');
    d.style.borderLeftColor = color;
    d.innerHTML = '<div class="t">' + label + '</div><div class="v">' + val.toFixed(1) + ' ft</div>';
    grid.appendChild(d);
  };
  addTot('TOTAL ROUTE', grand, '#38bdf8', true);
  for (const k of TYPE_ORDER) {
    if (k === 'strand' || k === 'lashing') continue;
    addTot(TYPES[k].label.toUpperCase(), tots[k] || 0, TYPES[k].color, false);
  }

  // points list
  const host = document.getElementById('fm-sum-points');
  host.innerHTML = '';
  state.points.forEach((p) => {
    const t = TYPES[p.type];
    const d = document.createElement('div');
    d.className = 'fm-pt';
    d.innerHTML =
      '<div class="ph"><span>' + (p.n) + ' · ' + escapeHtml(p.label || 'UNLABELED') + '</span>' +
      '<span class="fm-chip" style="background:' + t.color + '">' + t.label + '</span></div>' +
      '<div class="pd">' + p.lat.toFixed(6) + ', ' + p.lng.toFixed(6) + ' · ' +
      new Date(p.ts).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) +
      (p.segFt ? '<br>Segment ' + (p.n - 1) + '→' + p.n + ': ' + t.label + ' · ' + p.segFt.toFixed(1) + ' ft' : '<br>Route start') + '</div>' +
      '<input data-pt="' + p.id + '" placeholder="Custom point name…" value="' + escapeHtml(p.label || '') + '">';
    host.appendChild(d);
  });
  host.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('change', () => {
      const p = state.points.find((x) => x.id === inp.dataset.pt);
      if (p) { p.label = inp.value.trim(); drawRoute(); updatePointBar(); autosave(); }
    });
  });

  // summary mini-map
  const smEl = document.getElementById('fm-sum-map');
  smEl.innerHTML = '';
  try {
    const sm = L.map(smEl, { zoomControl: false, attributionControl: true });
    state.layers.sat.addTo(sm);
    const bounds = L.latLngBounds(state.points.map((p) => [p.lat, p.lng]));
    sm.fitBounds(bounds.pad(0.25));
    // draw route copy
    let run = [state.points[0]];
    for (let i = 1; i < state.points.length; i++) {
      if (state.points[i].type === run[run.length - 1].type) run.push(state.points[i]);
      else {
        const t = TYPES[run[0].type];
        L.polyline(run.map((p) => [p.lat, p.lng]), { color: t.color, weight: 4, dashArray: t.dash || null }).addTo(sm);
        run = [state.points[i - 1], state.points[i]];
      }
    }
    if (run.length >= 2) {
      const t = TYPES[run[0].type];
      L.polyline(run.map((p) => [p.lat, p.lng]), { color: t.color, weight: 4, dashArray: t.dash || null }).addTo(sm);
    }
    setTimeout(() => sm.invalidateSize(), 200);
    state._summaryMap = sm;
  } catch (e) { /* map thumb optional */ }

  autosave();
  ov.hidden = false;
  buzz(15);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ------------------------------------------------------------ persistence */

function serialize() {
  return {
    id: state.currentId || uuid(),
    ts: Date.now(),
    points: state.points.map((p) => ({
      id: p.id, n: p.n, type: p.type, lat: p.lat, lng: p.lng,
      label: p.label, ts: p.ts, segFt: p.segFt,
    })),
    totals: typeTotals(),
    grand: grandTotal(),
  };
}

function autosave() {
  try {
    const data = serialize();
    state.currentId = data.id;
    const all = loadAll();
    const i = all.findIndex((m) => m.id === data.id);
    if (i >= 0) all[i] = data; else all.unshift(data);
    localStorage.setItem(LS_KEY, JSON.stringify(all.slice(0, 50)));
    // also push to server API (best effort)
    fetch('/api/fieldmaps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).catch(() => {});
    document.getElementById('fm-savestate').textContent = '· saved ' +
      new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (e) { /* storage full etc */ }
}

function loadAll() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); }
  catch (e) { return []; }
}

function openMap(data) {
  state.currentId = data.id;
  state.points = data.points.map((p) => ({ ...p }));
  drawRoute();
  refreshTotals();
  updatePointBar();
  if (state.points.length && state.map) {
    state.map.fitBounds(L.latLngBounds(state.points.map((p) => [p.lat, p.lng])).pad(0.2));
  }
  document.getElementById('fm-tools-overlay').hidden = true;
  toast('Map loaded.', 'success');
}

/* ------------------------------------------------------------ export */

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

function exportJSON() {
  const data = serialize();
  data.exportedAt = new Date().toISOString();
  download('mercury-fieldmap-' + data.id.slice(0, 8) + '.json',
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  toast('Field map exported as JSON.', 'success');
}

async function exportPNG() {
  if (state.points.length === 0) {
    toast('Nothing to export yet.', 'warning');
    return;
  }
  toast('Rendering route image…', 'info');
  try {
    // Route bounds with padding
    const lats = state.points.map((p) => p.lat);
    const lngs = state.points.map((p) => p.lng);
    let minLat = Math.min(...lats), maxLat = Math.max(...lats);
    let minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const padLat = Math.max((maxLat - minLat) * 0.25, 0.0008);
    const padLng = Math.max((maxLng - minLng) * 0.25, 0.0008);
    minLat -= padLat; maxLat += padLat;
    minLng -= padLng; maxLng += padLng;

    // Static satellite image from Esri (reliable, no html2canvas tile issues)
    const W = 1200;
    const H = 900;
    const exportUrl =
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export' +
      '?bbox=' + minLng + ',' + minLat + ',' + maxLng + ',' + maxLat +
      '&bboxSR=4326&imageSR=4326&size=' + W + ',' + H + '&format=png&f=image';

    const bg = await new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const timer = setTimeout(() => reject(new Error('bg timeout')), 15000);
      img.onload = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); reject(new Error('bg load')); };
      img.src = exportUrl;
    });

    // Project lat/lng to canvas pixels (equirectangular is fine for small areas)
    const px = (lng) => ((lng - minLng) / (maxLng - minLng)) * W;
    const py = (lat) => H - ((lat - minLat) / (maxLat - minLat)) * H;

    const tots = typeTotals();
    const grand = grandTotal();
    const activeTypes = TYPE_ORDER.filter((k) => (tots[k] || 0) > 0);
    const barH = 150 + activeTypes.length * 52;
    const out = document.createElement('canvas');
    out.width = W; out.height = H + barH;
    const ctx = out.getContext('2d');
    ctx.drawImage(bg, 0, 0, W, H);

    // route segments
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let i = 1; i < state.points.length; i++) {
      const a = state.points[i - 1], b = state.points[i];
      const t = TYPES[b.type] || TYPES.aerial;
      ctx.strokeStyle = t.color;
      ctx.lineWidth = 10;
      if (t.dash) ctx.setLineDash(t.dash.split(' ').map(Number).map((n) => n * 3));
      else ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(px(a.lng), py(a.lat));
      ctx.lineTo(px(b.lng), py(b.lat));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // points
    for (const p of state.points) {
      const t = TYPES[p.type] || TYPES.aerial;
      const x = px(p.lng), y = py(p.lat);
      ctx.beginPath(); ctx.arc(x, y, 22, 0, Math.PI * 2);
      ctx.fillStyle = t.color; ctx.fill();
      ctx.lineWidth = 6; ctx.strokeStyle = '#ffffff'; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      // point number
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 26px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(p.n), x, y - 38);
    }

    // totals bar
    const by = H;
    ctx.fillStyle = '#101a30';
    ctx.fillRect(0, by, W, barH);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 54px system-ui, sans-serif';
    ctx.fillText('TOTAL  ' + grand.toFixed(1) + ' ft', 30, by + 48);
    ctx.fillStyle = '#9fb2d1';
    ctx.font = '400 24px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(new Date().toLocaleString(), W - 30, by + 48);
    ctx.textAlign = 'left';
    let ry = by + 112;
    for (const k of activeTypes) {
      const t = TYPES[k];
      ctx.fillStyle = t.color;
      ctx.beginPath(); ctx.arc(48, ry, 16, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e6edf7';
      ctx.font = '800 34px system-ui, sans-serif';
      ctx.fillText(t.label.toUpperCase(), 78, ry);
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 34px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(tots[k].toFixed(1) + ' ft', W - 30, ry);
      ctx.textAlign = 'left';
      ry += 52;
    }

    out.toBlob(async (blob) => {
      if (!blob) { toast('Could not render the image.', 'danger'); return; }
      const fname = 'mercury-fieldmap-' + (state.currentId || uuid()).slice(0, 8) + '.png';
      try {
        await savePhotos([blob]);
        toast('Route image saved to Photos.', 'success');
      } catch (e) {
        download(fname, blob);
        toast('Route image downloaded.', 'success');
      }
    }, 'image/png');
  } catch (e) {
    toast('Image export failed — check connection.', 'danger');
  }
}

/* ------------------------------------------------------------ send to job (Mercury rates) */

async function sendToJob() {
  const tots = typeTotals();
  const lines = [];
  const push = (type, qty) => {
    const r = RATE_MAP[type];
    if (!r || qty <= 0) return;
    lines.push({
      name: r.name,
      qty: type === 'bore' ? Math.max(1, Math.round(qty)) : Math.round(qty * 10) / 10,
      unit: r.unit, unitPrice: r.price,
      total: Math.round(qty * r.price * 100) / 100,
    });
  };
  push('aerial', tots.aerial);
  push('burial', tots.burial);
  push('conduit', tots.conduit);
  // bores: count bore-type segments
  let bores = 0;
  for (let i = 1; i < state.points.length; i++) {
    if (state.points[i].type === 'bore') bores++;
  }
  if (bores > 0) push('bore', bores);

  if (!lines.length) { toast('Nothing measured yet.', 'warning'); return; }

  try {
    const res = await fetch('/api/job-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'fieldmap', mapId: state.currentId, lines }),
    });
    if (res.ok) {
      const j = await res.json();
      toast('Sent to job draft (' + lines.length + ' lines).', 'success');
      if (j.url) location.href = j.url;
    } else {
      // fallback: stash in sessionStorage for the job form to pick up
      sessionStorage.setItem('mercury:fieldmap-lines', JSON.stringify(lines));
      toast('Saved — open a job to apply ' + lines.length + ' lines.', 'success');
    }
  } catch (e) {
    sessionStorage.setItem('mercury:fieldmap-lines', JSON.stringify(lines));
    toast('Saved — open a job to apply ' + lines.length + ' lines.', 'success');
  }
}

/* ------------------------------------------------------------ search */

let searchTimer = null;
function initSearch() {
  const input = document.getElementById('fm-search');
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 3) return;
    searchTimer = setTimeout(async () => {
      try {
        const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' + encodeURIComponent(q), {
          headers: { 'Accept': 'application/json' },
        });
        const list = await r.json();
        if (list && list[0] && state.map) {
          const { lat, lon } = list[0];
          state.map.setView([parseFloat(lat), parseFloat(lon)], 17);
          toast(list[0].display_name.split(',').slice(0, 2).join(','), 'info');
        } else toast('No results.', 'warning');
      } catch (e) { toast('Search failed — check connection.', 'warning'); }
    }, 600);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
}

/* ------------------------------------------------------------ tools sheet */

function renderSavedList() {
  const host = document.getElementById('fm-saved-list');
  const all = loadAll();
  host.innerHTML = all.length ? '<h3>SAVED MAPS</h3>' : '<p style="color:#9fb2d1;font-size:13px">No saved maps yet.</p>';
  all.slice(0, 20).forEach((m) => {
    const d = document.createElement('div');
    d.className = 'fm-pt';
    const when = new Date(m.ts).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    d.innerHTML = '<div class="ph"><span>' + (m.grand || 0).toFixed(1) + ' ft · ' + (m.points || []).length + ' pts</span><span style="color:#9fb2d1;font-weight:400">' + when + '</span></div>' +
      '<div class="fm-row" style="margin:8px 0 0"><button class="fm-btn" data-open="' + m.id + '">Open</button>' +
      '<button class="fm-btn warn" data-del="' + m.id + '">Delete</button></div>';
    host.appendChild(d);
  });
  host.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => {
      const m = loadAll().find((x) => x.id === b.dataset.open);
      if (m) openMap(m);
    }));
  host.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => {
      const all2 = loadAll().filter((x) => x.id !== b.dataset.del);
      localStorage.setItem(LS_KEY, JSON.stringify(all2));
      fetch('/api/fieldmaps/' + b.dataset.del, { method: 'DELETE' }).catch(() => {});
      renderSavedList();
    }));
}

/* ------------------------------------------------------------ wire up */

function wire() {
  document.getElementById('fm-start').addEventListener('click', () => {
    if (!state.map) { toast('Map is still loading.', 'warning'); return; }
    buzz(10);
    setMeasuring(true);
  });
  document.getElementById('fm-add').addEventListener('click', addPoint);
  document.getElementById('fm-undo').addEventListener('click', undoPoint);
  document.getElementById('fm-finish').addEventListener('click', finishRoute);

  document.getElementById('fm-locate').addEventListener('click', () => locate(true));
  document.getElementById('fm-center').addEventListener('click', () => locate(true));

  const toolsOv = document.getElementById('fm-tools-overlay');
  document.getElementById('fm-tools-btn').addEventListener('click', () => {
    renderSavedList();
    toolsOv.hidden = false;
  });
  document.getElementById('fm-tools-close').addEventListener('click', () => { toolsOv.hidden = true; });
  toolsOv.addEventListener('click', (e) => { if (e.target === toolsOv) toolsOv.hidden = true; });

  document.getElementById('fm-tool-gps').addEventListener('click', () => {
    toolsOv.hidden = true;
    state.activeType = 'aerial';
    renderTypes();
    toast('GPS route: walk the drop, tap Add point at each turn.', 'info');
    if (!state.measuring) setMeasuring(true);
  });
  document.getElementById('fm-tool-shapes').addEventListener('click', () => {
    toast('Shapes: coming soon — use Add point for now.', 'info');
  });
  document.getElementById('fm-tool-photo').addEventListener('click', () => {
    toast('Photo pin: coming soon.', 'info');
  });
  document.getElementById('fm-tool-saved').addEventListener('click', renderSavedList);
  document.getElementById('fm-tool-clear').addEventListener('click', () => {
    state.points = [];
    state.currentId = null;
    clearRoute(); refreshTotals(); updatePointBar();
    document.getElementById('fm-savestate').textContent = '';
    toolsOv.hidden = true;
    toast('Cleared.', 'info');
  });

  document.getElementById('fm-send-job').addEventListener('click', sendToJob);
  document.getElementById('fm-send-job2').addEventListener('click', sendToJob);
  document.getElementById('fm-export-json').addEventListener('click', exportJSON);
  document.getElementById('fm-export-png').addEventListener('click', exportPNG);
  document.getElementById('fm-sum-export').addEventListener('click', exportJSON);
  document.getElementById('fm-sum-image').addEventListener('click', exportPNG);

  const sumOv = document.getElementById('fm-summary-overlay');
  document.getElementById('fm-sum-close').addEventListener('click', () => {
    if (state._summaryMap) { try { state._summaryMap.remove(); } catch (e) {} state._summaryMap = null; }
    sumOv.hidden = true;
  });
  document.getElementById('fm-resume').addEventListener('click', () => {
    if (state._summaryMap) { try { state._summaryMap.remove(); } catch (e) {} state._summaryMap = null; }
    sumOv.hidden = true;
    setMeasuring(true);
    // restore points (setMeasuring cleared them) — re-add from last serialize
    const all = loadAll();
    const last = all[0];
    if (last && last.id === state.currentId) {
      state.points = last.points.map((p) => ({ ...p }));
      drawRoute(); refreshTotals(); updatePointBar();
    }
  });

  // relabel
  const relOv = document.getElementById('fm-relabel-overlay');
  document.getElementById('fm-relabel').addEventListener('click', () => {
    const p = state.points[state.points.length - 1];
    if (!p) return;
    document.getElementById('fm-relabel-input').value = p.label || '';
    relOv.hidden = false;
    setTimeout(() => document.getElementById('fm-relabel-input').focus(), 100);
  });
  document.getElementById('fm-relabel-cancel').addEventListener('click', () => { relOv.hidden = true; });
  document.getElementById('fm-relabel-save').addEventListener('click', () => {
    const p = state.points[state.points.length - 1];
    if (p) {
      p.label = document.getElementById('fm-relabel-input').value.trim();
      updatePointBar(); drawRoute(); autosave();
    }
    relOv.hidden = true;
  });

  initSearch();
}

/* ------------------------------------------------------------ boot */

let _booted = false;
function boot() {
  loadCustomTypes();
  if (_booted) return;
  _booted = true;
  try {
    initCustomPanel();
    renderTypes();
  } catch (e) {
    console.error('renderTypes failed:', e);
  }
  try {
    if (initMap()) {
      wire();
      locate(false);
    } else {
      wire();
    }
  } catch (e) {
    console.error('Map init failed:', e);
    const el = document.getElementById('fm-map');
    if (el) el.innerHTML = '<div style="display:grid;place-items:center;height:100%;color:#9fb2d1;text-align:center;padding:24px"><div><div style="font-size:30px">\u26a0\ufe0f</div><h3>Map failed to start</h3><p style="font-size:12px;opacity:.7">' + String(e.message || e).slice(0, 120) + '</p><button onclick="location.reload()" style="margin-top:12px;padding:10px 20px;border-radius:10px;border:1px solid #243049;background:#141d33;color:#e6edf7;">Reload</button></div></div>';
    try { wire(); } catch (e2) {}
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
