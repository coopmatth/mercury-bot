/* On-device photo compressor.
 *
 * The photo itself never leaves the phone: the file is decoded, drawn to a
 * canvas at the target long edge, stamped, and re-encoded as JPEG.
 *
 * Every compressed photo is stamped with the exact compress date/time and a
 * street address. Compression refuses to run without a real GPS fix (clear
 * error instead of a dateless stamp). The address comes from one
 * reverse-geocode lookup per batch (OpenStreetMap Nominatim), so the
 * coordinates do leave the phone for that lookup; when offline or the lookup
 * fails the stamp falls back to raw lat/lon. The location fix starts when
 * photos are picked so it doesn't block the compress button. The stamp
 * is drawn into the image itself, upper-right, so it survives any upload. */

import { toast, buzz } from './app.js';
import { isNativeApp, savePhotos, getNativeLocation } from './native.js';

const els = {
  files: document.getElementById('photo-files'),
  preset: document.getElementById('preset'),
  button: document.getElementById('compress-btn'),
  summary: document.getElementById('summary'),
  before: document.getElementById('size-before'),
  after: document.getElementById('size-after'),
  saved: document.getElementById('size-saved'),
  results: document.getElementById('results'),
  list: document.getElementById('result-list'),
  downloadAll: document.getElementById('download-all'),
};

let outputs = [];

const humanSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

els.files.addEventListener('change', () => {
  els.button.disabled = els.files.files.length === 0;
  els.button.textContent = els.files.files.length
    ? `Compress ${els.files.files.length} ${els.files.files.length === 1 ? 'photo' : 'photos'}`
    : 'Compress photos';
  // GPS warm-up: start the location fix as soon as photos are picked, so it
  // is usually ready by the time "Compress" is tapped instead of blocking
  // the batch on a cold GPS fix (which was adding 10+ seconds).
  pendingLocate = els.files.files.length ? locateForStamp() : null;
});

async function compress(file, maxEdge, quality, stamp) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  if (stamp) stampPhoto(ctx, canvas.width, canvas.height, stamp);

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality));
  return {
    name: file.name.replace(/\.[^.]+$/, '') + '-compressed.jpg',
    blob,
    originalSize: file.size,
    size: blob.size,
    dimensions: `${canvas.width}×${canvas.height}`,
  };
}

/* Location for the stamp. Native (iOS location services) first — reliable
 * inside the packaged app — then the web geolocation API, then null. The
 * failure reason is kept so the UI can say why instead of a bare
 * "unavailable". Started early (see pendingLocate) so the GPS fix doesn't
 * block the compress button. */
let lastLocateError = '';
let pendingLocate = null;

async function locateForStamp() {
  try {
    return await getNativeLocation();
  } catch (error) {
    // No bridge, old app build, or native failure — fall through to web.
    console.warn('[photos] native location failed:', error?.message || error);
  }
  return getWebPosition();
}

function getWebPosition(timeoutMs = 20000) {
  if (!('geolocation' in navigator)) {
    lastLocateError = 'this browser has no geolocation';
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (position, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        lastLocateError =
          { 1: 'permission denied', 2: 'position unavailable', 3: 'timed out' }[error.code]
          || 'unknown error';
      }
      resolve(position);
    };
    const timer = setTimeout(() => finish(null, { code: 3 }), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => finish({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      (error) => finish(null, error),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60000 },
    );
  });
}

/* Coordinates -> street address for the stamp, one lookup per batch.
 * OpenStreetMap Nominatim: no key, ~1 request/second limit (fine for one
 * user). Sends the coordinates to OSM's servers; offline or failure falls
 * back to raw lat/lon in the stamp. */
async function reverseGeocode(latitude, longitude, timeoutMs = 5000) {
  const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2' +
    `&lat=${latitude}&lon=${longitude}&zoom=18&addressdetails=1`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const addr = (await response.json()).address || {};
    const street = [addr.house_number, addr.road].filter(Boolean).join(' ');
    const city = addr.city || addr.town || addr.village || addr.hamlet
      || addr.municipality || '';
    const state = stateAbbr(addr.state) || addr.state || '';
    const cityLine = [city, [state, addr.postcode].filter(Boolean).join(' ')]
      .filter(Boolean).join(' ');
    if (!street && !cityLine) return null;
    return { street, cityLine };
  } catch {
    return null;
  }
}

const US_STATE_ABBR = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC',
  Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
  Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA',
  Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI',
  Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT',
  Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC',
  'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR',
  Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT',
  Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV',
  Wisconsin: 'WI', Wyoming: 'WY',
};

function stateAbbr(name) {
  return US_STATE_ABBR[name] || '';
}

/* 9/29/26 14:32 — matches the closeout sheet convention. */
function formatStampDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()}/${String(date.getFullYear()).slice(2)} ` +
         `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* Draws the timestamp + address stamp in the upper-right corner:
 *
 *   9/29/26 14:32
 *
 *   400 S 250 W
 *   Lagrange IN 46761
 *
 * stamp = { takenAt: Date, address: {street, cityLine} | null,
 *           coords: {latitude, longitude} | null } */
function stampPhoto(ctx, width, height, stamp) {
  const lines = [formatStampDate(stamp.takenAt), ''];
  if (stamp.address && (stamp.address.street || stamp.address.cityLine)) {
    if (stamp.address.street) lines.push(stamp.address.street);
    if (stamp.address.cityLine) lines.push(stamp.address.cityLine);
  } else if (stamp.coords) {
    lines.push(`${stamp.coords.latitude.toFixed(5)}, ${stamp.coords.longitude.toFixed(5)}`);
  } else {
    lines.push('location unavailable');
  }

  const pad = Math.max(12, Math.round(width * 0.025));
  let size = Math.max(15, Math.round(width / 40));
  const setFont = () => { ctx.font = `600 ${size}px system-ui, -apple-system, sans-serif`; };
  setFont();
  const longest = () => Math.max(...lines.map((line) => ctx.measureText(line).width), 1);
  while (longest() > width - pad * 2 && size > 10) {
    size -= 2;
    setFont();
  }

  const lineH = size * 1.35;
  const boxW = longest() + pad * 1.2;
  const boxH = lineH * lines.length + pad * 0.9;
  const boxX = width - pad * 0.6 - boxW;
  const boxY = pad * 0.6;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, size * 0.35);
    ctx.fill();
  } else {
    ctx.fillRect(boxX, boxY, boxW, boxH);
  }

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => {
    if (line) ctx.fillText(line, width - pad * 1.2, boxY + pad * 0.45 + i * lineH);
  });
  ctx.textAlign = 'left';
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* One photo, by whichever route the current container actually supports:
 * the camera roll in the packaged app, a download everywhere else. */
async function saveOne(output) {
  if (!isNativeApp()) {
    saveBlob(output.blob, output.name);
    return;
  }
  try {
    await savePhotos([output.blob]);
    toast('Saved to your camera roll.', 'success');
  } catch (error) {
    toast(error?.message || 'Could not save to your camera roll.', 'danger', 8000);
  }
}

els.button.addEventListener('click', async () => {
  const [edge, quality] = els.preset.value.split(':');
  els.button.disabled = true;
  els.button.textContent = 'Compressing…';
  outputs = [];

  try {
    // The stamp needs a real location — stop with a clear error instead of
    // stamping "location unavailable". The lookup started when the photos
    // were picked, so this rarely waits; 8s past the tap is the hard cap.
    const coords = await Promise.race([
      pendingLocate || locateForStamp(),
      new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
    pendingLocate = null;
    if (!coords) {
      throw new Error(lastLocateError
        ? `No location for the stamp (${lastLocateError}). Check location permission / GPS and try again.`
        : 'No location for the stamp. Check location permission / GPS and try again.');
    }
    // One reverse-geocode per batch; falls back to raw lat/lon in the stamp
    // if the address lookup itself fails.
    const address = await reverseGeocode(coords.latitude, coords.longitude);
    for (const file of els.files.files) {
      // Exact compress time — file.lastModified is import metadata, not
      // capture time, and stamped a seemingly random time.
      const takenAt = new Date();
      outputs.push(await compress(file, Number(edge), Number(quality),
        { takenAt, address, coords }));
    }
  } catch (error) {
    toast(`Could not compress: ${error.message}`, 'danger');
    els.button.disabled = false;
    els.button.textContent = 'Compress photos';
    return;
  }

  const before = outputs.reduce((sum, o) => sum + o.originalSize, 0);
  const after = outputs.reduce((sum, o) => sum + o.size, 0);
  els.before.textContent = humanSize(before);
  els.after.textContent = humanSize(after);
  els.saved.textContent = `${humanSize(before - after)} (${Math.round((1 - after / before) * 100)}%)`;
  els.summary.classList.remove('hidden');

  els.list.innerHTML = '';
  for (const output of outputs) {
    const row = document.createElement('div');
    row.className = 'list-item';
    row.innerHTML = `
      <div class="li-main"><div class="li-title"></div><div class="li-sub"></div></div>
      <button type="button" class="btn btn-sm btn-outline">Save</button>`;
    row.querySelector('.li-title').textContent = output.name;
    row.querySelector('.li-sub').textContent =
      `${output.dimensions} · ${humanSize(output.originalSize)} → ${humanSize(output.size)}`;
    row.querySelector('button').addEventListener('click', () => saveOne(output));
    els.list.appendChild(row);
  }
  els.results.classList.remove('hidden');

  buzz([12, 40, 12]);
  toast(`Compressed ${outputs.length} ${outputs.length === 1 ? 'photo' : 'photos'}.`, 'success');
  els.button.disabled = false;
  els.button.textContent = 'Compress photos';
});

els.downloadAll.addEventListener('click', async () => {
  if (!outputs.length) return;

  // Inside the packaged app, save straight to the camera roll. WKWebView
  // implements neither file sharing nor <a download>, so both web paths below
  // are silent no-ops there — which is why "Save all" appeared to do nothing
  // in the app while working in the PWA.
  if (isNativeApp()) {
    const original = els.downloadAll.textContent;
    els.downloadAll.disabled = true;
    els.downloadAll.textContent = 'Saving…';
    try {
      const saved = await savePhotos(outputs.map((o) => o.blob));
      buzz([12, 40, 12]);
      toast(`Saved ${saved} ${saved === 1 ? 'photo' : 'photos'} to your camera roll.`, 'success');
    } catch (error) {
      toast(error?.message || 'Could not save to your camera roll.', 'danger', 8000);
    } finally {
      els.downloadAll.disabled = false;
      els.downloadAll.textContent = original;
    }
    return;
  }

  // Share sheet first: on a phone it lands the photos straight into the
  // upload the technician actually needs them in.
  const files = outputs.map((o) => new File([o.blob], o.name, { type: 'image/jpeg' }));
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files, title: 'Compressed job photos' });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  outputs.forEach((o, i) => setTimeout(() => saveBlob(o.blob, o.name), i * 220));
});
