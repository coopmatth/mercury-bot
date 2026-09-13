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

// Rebuilds the Tesseract OCR garbage into your required template
function formatOcrToTemplate(rawText) {
  const t = rawText.toUpperCase().replace(/\s+/g, ' ');

  // Grab all 12-character identifiers in the raw text block
  const allMacs = [...t.matchAll(/([0-9A-F]{12})/g)].map(m => m[1]).filter(m => !m.startsWith('CXNK'));
  const allFsans = [...t.matchAll(/(CXNK[0-9A-F]{8})/g)].map(m => m[1]);
  const allSerials = [...t.matchAll(/([0-9]{12})/g)].map(m => m[1]);

  // Attempt to assign them based on specific label prefixes, fallback to array index
  const ontMac = t.match(/ONU\s*MAC[\s:=]*([0-9A-F]{12})/) ? t.match(/ONU\s*MAC[\s:=]*([0-9A-F]{12})/)[1] : (allMacs[0] || '');
  const mtaMac = t.match(/MTA\s*MAC[\s:=]*([0-9A-F]{12})/) ? t.match(/MTA\s*MAC[\s:=]*([0-9A-F]{12})/)[1] : (allMacs[1] || '');
  const serial = t.match(/SERIAL\s*NO\.?[\s:=]*([0-9]{12})/) ? t.match(/SERIAL\s*NO\.?[\s:=]*([0-9]{12})/)[1] : (allSerials[0] || '');
  
  const ontFsan = allFsans[0] || '';
  const routerFsan = allFsans.length > 1 ? allFsans[1] : (t.match(/SSID[\s:=]*(CXNK[0-9A-F]{8})/) ? t.match(/SSID[\s:=]*(CXNK[0-9A-F]{8})/)[1] : '');
  const routerMac = allMacs.length > 2 ? allMacs[2] : (t.match(/(?:[^U]\s|^)MAC[\s:=]*([0-9A-F]{12})/) ? t.match(/(?:[^U]\s|^)MAC[\s:=]*([0-9A-F]{12})/)[1] : '');

  return `DROP= (AERIAL, HYBRID, NEEDS BURY)
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
Rough NID Location =`;
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
        // Run Tesseract On-Device
        const worker = await Tesseract.createWorker('eng', 1, {
          workerPath: '/static/vendor/tesseract/worker.min.js',
          corePath: '/static/vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
          langPath: '/static/vendor/tesseract'
        });
        
        let combinedText = "";
        for (const file of fileInput.files) {
          const { data: { text } } = await worker.recognize(file);
          combinedText += " " + text;
        }
        await worker.terminate();
        
        // Format the raw local text into the template
        finalPayload = formatOcrToTemplate(combinedText);

      } else {
        // Run AI Engine (which natively outputs the perfect template)
        const formData = new FormData();
        for (const file of fileInput.files) formData.append('images', file);
        const res = await fetch('/api/parse-equipment', { method: 'POST', body: formData });
        const data = await res.json();
        
        finalPayload = data.text || formatOcrToTemplate("");
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
        <div class="code-block" style="font-size: 13px; padding: 12px; min-height: auto; user-select: all; overflow-x: auto; background: var(--bg-2); border: 1px solid var(--line-soft);">${payload}</div>
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
    const text = decodeURIComponent(e.target.dataset.text);
    navigator.clipboard.writeText(text);
    window.mercury.toast('Copied to clipboard!', 'success');
  }
});
