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

function parseEquipmentLabel(rawText) {
  const text = rawText.toUpperCase().replace(/\s+/g, ' ');
  const result = { type: 'UNKNOWN', serial: null, mac: null, id_string: null };

  if (text.includes('1101X') || text.includes('ONT')) result.type = 'ONT 1101X';
  else if (text.includes('U6.3') || text.includes('GS4229E')) result.type = 'ROUTER u6.3';
  else if (text.includes('GS7') || text.includes('GS5239E')) result.type = 'ROUTER GS7';
  else if (text.includes('ROUTER INFO')) result.type = 'ROUTER';

  const extract = (regex) => {
    const match = text.match(regex);
    return match ? match[1].replace(/[-:\s=]/g, '') : null;
  };

  // Expanded to support AI "=" formatting and OCR ":" formatting
  result.serial = extract(/(?:SERIAL\s*NO\.?|S\/N)[\s:=]+([0-9]{12})/) || extract(/(?:^|\s)([0-9]{12})(?:\s|$)/); 
  result.mac = extract(/(?:ONU\s*MAC|MTA\s*MAC|MAC)[\s:=]+([0-9A-F]{12})/);
  result.id_string = extract(/(CXNK[0-9A-F]{8})/);

  return result;
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
      let rawText = "";

      if (forceLocalEngine || !navigator.onLine) {
        // Force Tesseract to use your local cached files instead of the internet
        const worker = await Tesseract.createWorker('eng', 1, {
          workerPath: '/static/vendor/tesseract/worker.min.js',
          corePath: '/static/vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
          langPath: '/static/vendor/tesseract'
        });
        
        for (const file of fileInput.files) {
          const { data: { text } } = await worker.recognize(file);
          rawText += " " + text;
        }
        await worker.terminate();
      } else {
        const formData = new FormData();
        for (const file of fileInput.files) formData.append('images', file);
        const res = await fetch('/api/parse-equipment', { method: 'POST', body: formData });
        const data = await res.json();
        rawText = data.text || "";
      }

      const equipment = parseEquipmentLabel(rawText);
      const payloadString = `TYPE: ${equipment.type}\nSN: ${equipment.serial || '—'}\nMAC: ${equipment.mac || '—'}\nID: ${equipment.id_string || '—'}`;
      
      const saved = await window.mercury.saveScan({
        payload: payloadString,
        source: forceLocalEngine || !navigator.onLine ? 'offline' : 'ai'
      });

      renderResult(equipment, saved.id);

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

function renderResult(eq, id) {
  const isComplete = eq.serial && eq.mac && eq.id_string;
  const statusHtml = isComplete ? `<span class="badge badge-green">Complete</span>` : `<span class="badge badge-amber">Missing Data</span>`;

  const itemHtml = `
    <div class="list-item" data-scan-id="${id}">
      <div class="li-main">
        <div class="flex-between mb-1">
          <div class="li-title" style="font-size: 16px;">${eq.type}</div>
          ${statusHtml}
        </div>
        <div class="li-sub" style="font-family: var(--mono); color: var(--text);">
          <div><span style="color: var(--text-mute);">SN:</span> ${eq.serial || '—'}</div>
          <div><span style="color: var(--text-mute);">MAC:</span> ${eq.mac || '—'}</div>
          <div><span style="color: var(--text-mute);">ID:</span> ${eq.id_string || '—'}</div>
        </div>
      </div>
      <button type="button" class="btn btn-sm btn-danger delete-scan-btn" data-id="${id}">✕</button>
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
});
