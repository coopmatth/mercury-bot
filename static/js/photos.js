/* On-device photo compressor.
 *
 * Nothing leaves the phone: the file is decoded, drawn to a canvas at the
 * target long edge and re-encoded as JPEG. Useful when a job needs photos
 * uploaded over one bar of LTE. */

import { toast, buzz } from './app.js';

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

async function compress(file, maxEdge, quality) {
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

els.button.addEventListener('click', async () => {
  const [edge, quality] = els.preset.value.split(':');
  els.button.disabled = true;
  els.button.textContent = 'Compressing…';
  outputs = [];

  try {
    for (const file of els.files.files) {
      outputs.push(await compress(file, Number(edge), Number(quality)));
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
    row.querySelector('button').addEventListener('click', () => saveBlob(output.blob, output.name));
    els.list.appendChild(row);
  }
  els.results.classList.remove('hidden');

  buzz([12, 40, 12]);
  toast(`Compressed ${outputs.length} ${outputs.length === 1 ? 'photo' : 'photos'}.`, 'success');
  els.button.disabled = false;
  els.button.textContent = 'Compress photos';
});

els.downloadAll.addEventListener('click', async () => {
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
