/* ---------------------------------------------------- scanner.js */

// --- 1. Engine Toggle Logic ---
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

// --- 2. Strict Equipment Parsing Engine ---
function parseEquipmentLabel(rawText) {
  // Normalize text to handle OCR inconsistencies (spaces, line breaks)
  const text = rawText.toUpperCase().replace(/\s+/g, ' ');
  
  const result = {
    type: 'UNKNOWN',
    serial: null,
    mac: null,
    id_string: null 
  };

  // Identify hardware model
  if (text.includes('1101X') || text.includes('ONT')) {
    result.type = 'ONT 1101X';
  } else if (text.includes('U6.3') || text.includes('GS4229E')) {
    result.type = 'ROUTER u6.3';
  } else if (text.includes('GS7') || text.includes('GS5239E')) {
    result.type = 'ROUTER GS7';
  }

  // Regex extractor targeting specific 12-char blocks and CXNK structures
  const extract = (regex) => {
    const match = text.match(regex);
    return match ? match[1].replace(/[-:\s]/g, '') : null;
  };

  // Serial: Exactly 12 numeric digits
  result.serial = extract(/SERIAL\s*NO\.?\s*:\s*([0-9]{12})/) 
               || extract(/(?:^|\s)([0-9]{12})(?:\s|$)/); 

  // MAC: 12 Hex characters. Catch standard MAC, ONU MAC, or MTA MAC.
  result.mac = extract(/ONU\s*MAC\s*:\s*([0-9A-F]{12})/) 
            || extract(/MTA\s*MAC\s*:\s*([0-9A-F]{12})/)
            || extract(/MAC\s*:\s*([0-9A-F]{12})/);

  // FSAN/SSID: Always begins with CXNK followed by exactly 8 Hex characters
  result.id_string = extract(/(CXNK[0-9A-F]{8})/);

  return result;
}

// --- 3. Scanner Form Submission ---
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

      // Route image to chosen engine (force local if offline)
      if (forceLocalEngine || !navigator.onLine) {
        // Tesseract On-Device Processing
        for (const file of fileInput.files) {
          const { data: { text } } = await Tesseract.recognize(file, 'eng');
          rawText += " " + text;
        }
      } else {
        // AI Backend Processing
        const formData = new FormData();
        for (const file of fileInput.files) {
          formData.append('images', file);
        }
        const res = await fetch('/api/scanner/analyze', { method: 'POST', body: formData });
        const data = await res.json();
        rawText = data.text || "";
      }

      // Parse the unified text block
      const equipment = parseEquipmentLabel(rawText);
      renderResult(equipment);

    } catch (error) {
      console.error("Scan failed:", error);
      alert("Scan failed. Try adjusting the photo lighting.");
    } finally {
      readBtn.innerHTML = originalBtnText;
      readBtn.disabled = false;
      fileInput.value = ''; // Reset input
    }
  });
}

function renderResult(eq) {
  const isComplete = eq.serial && eq.mac && eq.id_string;
  const statusHtml = isComplete 
    ? `<span class="badge badge-green">Complete</span>` 
    : `<span class="badge badge-amber">Missing Data</span>`;

  const itemHtml = `
    <div class="list-item">
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
    </div>
  `;

  const emptyState = resultsContainer.querySelector('.empty');
  if (emptyState) emptyState.remove();
  resultsContainer.insertAdjacentHTML('afterbegin', itemHtml);
}
