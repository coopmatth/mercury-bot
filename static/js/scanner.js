import { saveScan, store, toast, buzz } from './app.js';

const TEMPLATE = ({ ontMac = '', mtaMac = '', ontFsan = '', serial = '',
                    routerFsan = '', routerMac = '', extra = '' }) =>
`DROP= (AERIAL, HYBRID, NEEDS BURY)
ONT INFO
MAC = ${ontMac}
MTA MAC = ${mtaMac}
FSAN = ${ontFsan}
S/N = ${serial}
DB Levels/Light Levels = 
Fiber Jumper Length = 
LCP = 
ROUTER INFO 
FSAN = ${routerFsan}
MAC = ${routerMac}
Provision speeds = 
Actual Speeds = 
Uploaded Pictures (Yes/No) = 
Rough NID Location = ${extra}`;

const els = {
  files: document.getElementById('files'),
  thumbs: document.getElementById('thumbs'),
  scan: document.getElementById('scan-btn'),
  engine: document.getElementById('engine-pill'),
  progressWrap: document.getElementById('progress-wrap'),
  progressText: document.getElementById('progress-text'),
  progressBar: document.getElementById('progress-bar'),
  resultCard: document.getElementById('result-card'),
  resultSource: document.getElementById('result-source'),
  output: document.getElementById('output'),
  copy: document.getElementById('copy-btn'),
  saveScan: document.getElementById('save-scan-btn'),
  list: document.getElementById('scan-list'),
  count: document.getElementById('scan-count'),
};

let selected = [];

function updateEngine() {
  const online = navigator.onLine;
  els.engine.className = online ? 'pill pill-online' : 'pill pill-offline';
  els.engine.innerHTML = '<span class="dot"></span><span></span>';
  els.engine.lastElementChild.textContent = online ? 'AI reader' : 'On-device OCR';
}
window.addEventListener('online', updateEngine);
window.addEventListener('offline', updateEngine);
updateEngine();

function progress(text, fraction = null) {
  els.progressWrap.classList.remove('hidden');
  els.progressText.textContent = text;
  if (fraction !== null) els.progressBar.style.width = `${Math.round(fraction * 100)}%`;
}

function hideProgress() {
  els.progressWrap.classList.add('hidden');
  els.progressBar.style.width = '0%';
}

els.files.addEventListener('change', () => {
  selected = [...els.files.files];
  els.thumbs.innerHTML = '';
  for (const file of selected) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.onload = () => URL.revokeObjectURL(img.src);
    Object.assign(img.style, {
      width: '62px', height: '62px', objectFit: 'cover',
      borderRadius: '10px', border: '1px solid var(--line)',
    });
    els.thumbs.appendChild(img);
  }
  els.scan.disabled = selected.length === 0;
  els.scan.textContent = selected.length
    ? `Read ${selected.length} ${selected.length === 1 ? 'label' : 'labels'}`
    : 'Read labels';
});

async function preprocess(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(2.5, Math.max(1, 1800 / Math.max(bitmap.width, bitmap.height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = image.data;

  let sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  }
  const mean = sum / (px.length / 4);
  const cutoff = mean * 0.92;

  for (let i = 0; i < px.length; i += 4) {
    const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const value = lum > cutoff ? 255 : 0;
    px[i] = px[i + 1] = px[i + 2] = value;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function extractFields(rawText) {
  const upper = rawText.toUpperCase();
  const isOnt = /\bONT\b|PON|1101|803/.test(upper);
  const isRouter = /GIGA|BLAST|U6|U4M|10GW|ROUTER|SSID/.test(upper);

  const clean = upper.replace(/[OQ]/g, '0').replace(/I/g, '1');
  const fsans = [...new Set(clean.match(/CXNK[0-9A-F]{8}/g) || [])];
  const serials = [...new Set(clean.match(/\b\d{12,15}\b/g) || [])];
  const macs = [...new Set((clean.match(/\b[0-9A-F]{12}\b/g) || [])
    .filter((m) => !serials.includes(m)))];

  return { isOnt, isRouter, fsans, serials, macs };
}

function assemble(findings) {
  const ont = { fsans: [], macs: [], serials: [] };
  const router = { fsans: [], macs: [] };
  const unknown = { fsans: [], macs: [], serials: [] };

  for (const f of findings) {
    const bucket = f.isOnt ? ont : (f.isRouter ? router : unknown);
    bucket.fsans.push(...f.fsans);
    bucket.macs.push(...f.macs);
    if (bucket.serials) bucket.serials.push(...f.serials);
    else unknown.serials.push(...f.serials);
  }

  const uniq = (a) => [...new Set(a)];
  ont.fsans = uniq(ont.fsans); ont.macs = uniq(ont.macs); ont.serials = uniq(ont.serials);
  router.fsans = uniq(router.fsans); router.macs = uniq(router.macs);
  unknown.fsans = uniq(unknown.fsans); unknown.macs = uniq(unknown.macs);
  unknown.serials = uniq(unknown.serials);

  if (!ont.fsans.length && unknown.fsans.length) ont.fsans.push(unknown.fsans.shift());
  if (!router.fsans.length && unknown.fsans.length) router.fsans.push(unknown.fsans.shift());
  while (ont.macs.length < 2 && unknown.macs.length) ont.macs.push(unknown.macs.shift());
  if (!router.macs.length && unknown.macs.length) router.macs.push(unknown.macs.shift());

  return TEMPLATE({
    ontMac: ont.macs[0] || '',
    mtaMac: ont.macs[1] || '',
    ontFsan: ont.fsans[0] || '',
    serial: ont.serials[0] || unknown.serials[0] || '',
    routerFsan: router.fsans[0] || unknown.fsans[0] || '',
    routerMac: router.macs[0] || '',
  });
}

async function runOfflineOcr() {
  if (typeof Tesseract === 'undefined') {
    throw new Error('The offline reader is still downloading. Try again in a moment.');
  }

  progress('Starting the on-device reader…', 0.02);
  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: '/static/vendor/tesseract/worker.min.js',
    corePath: '/static/vendor/tesseract/',
    langPath: '/static/vendor/tesseract/',
    gzip: true,
    logger: (m) => {
      if (m.status === 'recognizing text') progress('Reading the label…', 0.15 + m.progress * 0.8);
    },
  });

  try {
    await worker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
      tessedit_char_whitelist:
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:.-/# ',
    });

    const findings = [];
    for (let i = 0; i < selected.length; i += 1) {
      progress(`Reading photo ${i + 1} of ${selected.length}…`, i / selected.length);
      const canvas = await preprocess(selected[i]);
      const { data } = await worker.recognize(canvas);
      findings.push(extractFields(data.text || ''));
    }
    return assemble(findings);
  } finally {
    await worker.terminate();
  }
}

async function compressForAI(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
}

async function runAiParse() {
  progress('Compressing photos for fast upload…', 0.1);
  const body = new FormData();
  
  for (let i = 0; i < selected.length; i++) {
    const blob = await compressForAI(selected[i]);
    body.append('images', blob, selected[i].name);
  }

  progress('Sending photos to the AI reader…', 0.4);
  const response = await fetch('/api/parse-equipment', { method: 'POST', body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw Object.assign(new Error(data.error || `Server responded ${response.status}`),
                        { fallback: data.fallback === 'offline' });
  }
  return data.text;
}

els.scan.addEventListener('click', async () => {
  if (!selected.length) return;
  els.scan.disabled = true;
  els.resultCard.classList.add('hidden');

  let text = null;
  let source = 'On-device OCR';

  try {
    if (navigator.onLine) {
      try {
        text = await runAiParse();
        source = 'AI reader';
      } catch (error) {
        toast(`${error.message} Falling back to on-device OCR.`, 'warning', 5000);
        text = await runOfflineOcr();
      }
    } else {
      text = await runOfflineOcr();
    }

    els.output.value = text;
    els.resultSource.textContent = source;
    els.resultCard.classList.remove('hidden');
    els.resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    buzz([12, 40, 12]);
  } catch (error) {
    toast(error.message, 'danger', 6000);
  } finally {
    hideProgress();
    els.scan.disabled = false;
  }
});

els.copy.addEventListener('click', async () => {
  const text = els.output.value;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    els.output.select();
    document.execCommand('copy');
  }
  buzz();
  toast('Copied to clipboard.', 'success');
});

els.saveScan.addEventListener('click', async () => {
  const address = window.prompt('Label this scan (address or order number):', '');
  if (address === null) return;
  await saveScan({
    address: address.trim(),
    payload: els.output.value,
    source: els.resultSource.textContent === 'AI reader' ? 'ai' : 'offline',
    work_date: new Date().toISOString().slice(0, 10),
  });
  toast('Scan saved to this device.', 'success');
  renderHistory();
});

async function renderHistory() {
  const scans = (await store.all('equipment_scans'))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 25);
  els.count.textContent = String(scans.length);

  if (!scans.length) return;
  els.list.innerHTML = '';
  for (const scan of scans) {
    const row = document.createElement('div');
    row.className = 'list-item';
    row.innerHTML = `
      <div class="li-main">
        <div class="li-title"></div>
        <div class="li-sub"></div>
      </div>
      <button type="button" class="btn btn-sm btn-ghost">Load</button>`;
    row.querySelector('.li-title').textContent = scan.address || 'Untitled scan';
    row.querySelector('.li-sub').textContent =
      `${new Date(scan.created_at).toLocaleString()} · ${scan.source === 'ai' ? 'AI' : 'OCR'}`;
    row.querySelector('button').addEventListener('click', () => {
      els.output.value = scan.payload;
      els.resultSource.textContent = scan.source === 'ai' ? 'AI reader' : 'On-device OCR';
      els.resultCard.classList.remove('hidden');
      els.resultCard.scrollIntoView({ behavior: 'smooth' });
    });
    els.list.appendChild(row);
  }
}
renderHistory();
document.addEventListener('mercury:synced', renderHistory);

if ('requestIdleCallback' in window) {
  requestIdleCallback(() => {
    ['worker.min.js', 'eng.traineddata.gz', 'tesseract-core-simd-lstm.wasm.js']
      .forEach((name) => fetch(`/static/vendor/tesseract/${name}`).catch(() => {}));
  }, { timeout: 8000 });
}
