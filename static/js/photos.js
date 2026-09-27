/* On-device photo compressor.
 *
 * Nothing leaves the phone: the file is decoded, drawn to a canvas at the
 * target long edge and re-encoded as JPEG. Useful when a job needs photos
 * uploaded over one bar of LTE.
 *
 * Every compressed photo is stamped with the capture date/time and the
 * device's current geolocation — the closeout validation requires all
 * photos to be timestamped. The stamp is drawn as a legible bar along the
 * bottom edge of the image itself, so it survives any upload. */

import { toast, buzz } from './app.js';
import { isNativeApp, savePhotos } from './native.js';

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

/* One geolocation lookup per batch — not per photo — so the permission
 * prompt (if any) appears once. Resolves null when geolocation is
 * unavailable, denied, or times out; the date stamp is applied regardless. */
function getPosition(timeoutMs = 8000) {
  if (!('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (pos) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(pos);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => finish(pos),
      () => finish(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60000 },
    );
  });
}

function formatStampDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
         `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* Draws the timestamp + geolocation bar along the bottom edge of the photo.
 * stamp = { takenAt: Date, position: GeolocationPosition | null } */
function stampPhoto(ctx, width, height, stamp) {
  const pad = Math.max(12, Math.round(width * 0.025));
  const loc = stamp.position
    ? `${stamp.position.coords.latitude.toFixed(6)}, ${stamp.position.coords.longitude.toFixed(6)}`
    : 'location unavailable';
  const text = `${formatStampDate(stamp.takenAt)}  ·  ${loc}`;

  let size = Math.max(15, Math.round(width / 44));
  const setFont = () => { ctx.font = `600 ${size}px system-ui, -apple-system, sans-serif`; };
  setFont();
  while (ctx.measureText(text).width > width - pad * 2 && size > 10) {
    size -= 2;
    setFont();
  }

  const barH = Math.round(size * 1.9);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, height - barH, width, barH);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, height - barH / 2);
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
    // Capture timestamp comes from the file itself (camera capture time);
    // geolocation is looked up once for the whole batch.
    const position = await getPosition();
    for (const file of els.files.files) {
      const takenAt = new Date(file.lastModified || Date.now());
      outputs.push(await compress(file, Number(edge), Number(quality), { takenAt, position }));
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
