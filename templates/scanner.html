let forceLocalEngine = false;

const btnAi = document.getElementById('toggle-ai');
const btnLocal = document.getElementById('toggle-local');

function updateToggleUI(useLocal) {
  forceLocalEngine = useLocal;
  if (useLocal) {
    btnLocal.style.background = 'var(--surface-2)';
    btnLocal.style.borderColor = 'var(--line)';
    btnLocal.style.color = 'var(--text)';
    btnAi.style.background = 'transparent';
    btnAi.style.borderColor = 'transparent';
    btnAi.style.color = 'var(--text-mute)';
  } else {
    btnAi.style.background = 'var(--surface-2)';
    btnAi.style.borderColor = 'var(--line)';
    btnAi.style.color = 'var(--text)';
    btnLocal.style.background = 'transparent';
    btnLocal.style.borderColor = 'transparent';
    btnLocal.style.color = 'var(--text-mute)';
  }
}

if (btnAi && btnLocal) {
  btnAi.addEventListener('click', () => updateToggleUI(false));
  btnLocal.addEventListener('click', () => updateToggleUI(true));
}

function formatOcrToTemplate(texts) {
  let ont = { mac: '', mta: '', fsan: '', sn: '' };
  let router = { fsan: '', mac: '' };
  let debugLog = "\n\n=== RAW OCR DEBUG LOG ===\n";

  const fix = (s) => s ? s.replace(/O/g, '0').replace(/I/g, '1').replace(/S/g, '5') : '';

  texts.forEach((rawText, index) => {
    debugLog += `\n[PHOTO ${index + 1}]\n${rawText}\n`;
    const t = rawText.toUpperCase().replace(/\s+/g, ' ');

    const extract = (regex) => {
      const m = t.match(regex);
      return m ? fix(m[1].replace(/[-:\s=]/g, '')) : '';
    };

    // Broadened classification: ONT labels use "PART NO" or "ONU", Routers use "MODEL NO"
    const isOnt = /ONU/.test(t) || /PART/.test(t) || /1101/.test(t) || /GP11/.test(t);

    if (isOnt) {
      ont.sn = extract(/(?:SERIAL|S\/N)[^\dOIS]*([0-9OIS]{12})/) || extract(/(?:^|\s)([0-9OIS]{12})(?:\s|$)/) || '';
      ont.mac = extract(/O[N0]U\s*M[A-Z]C[^\dA-Z]*([0-9A-Z]{12})/) || extract(/M[A-Z]C[^\dA-Z]*([0-9A-Z]{12})/) || '';
      ont.mta = extract(/MTA\s*M[A-Z]C[^\dA-Z]*([0-9A-Z]{12})/) || '';
      let fsanMatch = t.match(/(CXNK[0-9A-Z]{8})/);
      if(fsanMatch) ont.fsan = 'CXNK' + fix(fsanMatch[1].substring(4));
    } else {
      router.mac = extract(/(?:[^A-Z]|^)M[A-Z]C[^\dA-Z]*([0-9A-Z]{12})/) || extract(/M[A-Z]C[^\dA-Z]*([0-9A-Z]{12})/) || '';
      let fsanMatch = t.match(/(CXNK[0-9A-Z]{8})/);
      if(fsanMatch) router.fsan = 'CXNK' + fix(fsanMatch[1].substring(4));
    }
  });

  const template = `DROP= (AERIAL, HYBRID, NEEDS BURY)
ONT INFO
MAC = ${ont.mac}
MTA MAC = ${ont.mta}
FSAN = ${ont.fsan}
S/N = ${ont.sn}
DB Levels/Light Levels = 
Fiber Jumper Length = 
LCP = 
ROUTER INFO 
FSAN = ${router.fsan}
MAC = ${router.mac}
Provision speeds = 
Actual Speeds = 
Uploaded Pictures (Yes/No) = 
Rough NID Location =`;

  return template + debugLog;
}

const scannerForm = document.getElementById('scanner-form');
const fileInput = document.getElementById('scanner-files');
const readBtn = document.getElementById('read-btn');
const resultsContainer = document.getElementById('scanner-results');

if (scannerForm) {
  scannerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!fileInput.files.length) return;

    const originalBtnText = readBtn.innerHTML;
    readBtn.innerHTML = '<span class="spinner"></span> Processing...';
    readBtn.disabled = true;

    try {
      let finalPayload = "";

      if (forceLocalEngine || !navigator.onLine) {
        const worker = await Tesseract.createWorker('eng', 1, {
          workerPath: '/static/vendor/tesseract/worker.min.js',
          corePath: '/static/vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
          langPath: '/static/vendor/tesseract'
        });
        
        let texts = [];
        for (const file of fileInput.files) {
          const { data: { text } } = await worker.recognize(file);
          texts.push(text);
        }
        await worker.terminate();
        
        finalPayload = formatOcrToTemplate(texts);

      } else {
        const formData = new FormData();
        for (const file of fileInput.files) formData.append('images', file);
        const res = await fetch('/api/parse-equipment', { method: 'POST', body: formData });
        const data = await res.json();
        
        // Append a blank debug block if using AI to maintain structure
        finalPayload = (data.text || formatOcrToTemplate([])) + "\n\n=== RAW OCR DEBUG LOG ===\n[AI ENGINE USED - NO RAW LOGS]";
      }
      
      const saved = await window.mercury.saveScan({
        payload: finalPayload,
        source: forceLocalEngine || !navigator.onLine ? 'offline' : 'ai'
      });

      renderResult(finalPayload, saved.id, saved.source);

    } catch (error) {
      console.error(error);
      window.mercury.toast("Scan failed. Try adjusting the photo lighting.", "danger");
    } finally {
      readBtn.innerHTML = originalBtnText;
      readBtn.disabled = false;
      fileInput.value = '';
    }
  });
}

function renderResult(payload, id, source) {
  const itemHtml = `
    <div class="list-item" data-scan-id="${id}" style="align-items: flex-start; padding: 16px;">
      <div class="li-main" style="width: 100%;">
        <div class="flex-between mb-2">
          <span class="badge badge-soft">${source === 'ai' ? '✨ AI Engine' : '📱 On-Device'}</span>
          <div style="display: flex; gap: 8px;">
            <button type="button" class="btn btn-sm btn-primary copy-btn" data-text="${encodeURIComponent(payload)}">Copy</button>
            <button type="button" class="btn btn-sm btn-danger delete-scan-btn" data-id="${id}">✕</button>
          </div>
        </div>
        <div class="code-block" style="font-size: 13px; padding: 12px; min-height: auto; user-select: all; overflow-x: auto; background: var(--bg-2); border: 1px solid var(--line-soft); white-space: pre-wrap;">${payload}</div>
      </div>
    </div>
  `;

  const emptyState = resultsContainer.querySelector('.empty');
  if (emptyState) emptyState.remove();
  resultsContainer.insertAdjacentHTML('afterbegin', itemHtml);
}

document.addEventListener('click', async (e) => {
  if (e.target.classList.contains('delete-scan-btn')) {
    if (!confirm('Delete this saved scan?')) return;
    const id = e.target.dataset.id;
    await window.mercury.removeRow('equipment_scans', id);
    e.target.closest('.list-item').remove();
    window.mercury.toast('Scan deleted.', 'success');
  }
  if (e.target.classList.contains('copy-btn')) {
    // Strip the debug log before copying to clipboard
    const text = decodeURIComponent(e.target.dataset.text).split('=== RAW OCR DEBUG LOG ===')[0].trim();
    navigator.clipboard.writeText(text);
    window.mercury.toast('Copied to clipboard!', 'success');
  }
});
