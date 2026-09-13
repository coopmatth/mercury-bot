import { isNativeApp, recognizeText } from './native.js';

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
  btnLocal.addEventListener('click', () => {
    updateToggleUI(true);
    // On-device reading is Apple's Vision engine, which only exists inside the
    // packaged app. Say so at the moment of choosing rather than letting the
    // scan fail later with nothing to act on.
    if (!isNativeApp()) {
      window.mercury.toast(
        'On-device reading needs the Mercury iOS app. In a browser, use the AI engine while online.',
        'warning', 7000);
    }
  });

  // Vision is the default wherever it exists: it returns in about a second,
  // works with no signal, and reads these labels at least as well as the AI
  // round trip — which can take 30-45 seconds on a weak connection. In a
  // browser there is no Vision to select, so the AI engine leads there.
  updateToggleUI(isNativeApp());
}

/* Which device is a given label photo of?
 *
 * Keyed on product families, because generic words on the label are not
 * discriminating: the previous rule treated any label containing "PART" as an
 * ONT — true of the GP1101X, but the GS7 gateway prints "Part No." too, so a
 * GS7 was filed as an ONT and its MAC overwrote the real one.
 *
 * Gateways seen in the field: GigaSpire BLAST u6.3 (GS4229E), GS7 10GE Tri
 * Gateway (GS5239E). ONTs: GP1101X XGS-PON. The credential block (SSID, WPA
 * key, 192.168.x.x gateway address) only ever appears on a router, so it
 * counts too — a gateway whose model line is glared out is still recognisable
 * by the fact that it has a wifi password printed on it.
 */
const ROUTER_MARKERS = [
  /\bGIGASPIRE\b/, /\bBLAST\b/, /\bGATEWAY\b/,
  /\bGS\d{4}[A-Z]?\b/,        // GS4229E, GS5239E
  /\bGS\d{1,2}\b/,            // GS7
  /\bU6(?:\.\d+)?\b/,         // u6, u6.3
  /\bU4M\b/,
  /\b10GE\b/,
  /\bSSID\b/, /\bWPA\b/,
  /\bIP ADDRESS\b/, /\b192\.168\./,
];

const ONT_MARKERS = [
  /\bONT\b/, /\bONU\b/, /\bPON\b/, /\bXGS\b/,
  /\bGP\s?\d{4}/,             // GP1101X
  /\b1101X?\b/,
];

function classify(text, ont) {
  const hits = (markers) => markers.filter((re) => re.test(text)).length;
  const ontScore = hits(ONT_MARKERS);
  const routerScore = hits(ROUTER_MARKERS);

  // Whichever family the label matches more of wins, so one stray word can't
  // flip a whole photo.
  if (ontScore !== routerScore) return ontScore > routerScore;

  // Nothing decisive either way (a model line lost to glare, say). Every job
  // has an ONT and only some have a router, so fill the ONT first and let a
  // second unidentifiable label fall through to the router.
  return !ont.mac && !ont.fsan;
}

function formatOcrToTemplate(texts) {
  let ont = { mac: '', mta: '', fsan: '', sn: '' };
  let router = { fsan: '', mac: '' };

  const fix = (s) => s ? s.replace(/O/g, '0').replace(/I/g, '1').replace(/S/g, '5') : '';

  texts.forEach((rawText) => {
    const t = rawText.toUpperCase().replace(/\s+/g, ' ');

    const extract = (regex) => {
      const m = t.match(regex);
      return m ? fix(m[1].replace(/[-:\s=]/g, '')) : '';
    };

    const isOnt = classify(t, ont);

    // First good read wins. A second photo of the same device — a reshoot, or
    // a blurry angle that yields nothing — must not blank a field that an
    // earlier photo already filled.
    const fsanMatch = t.match(/(CXNK[0-9A-Z]{8})/);
    const fsan = fsanMatch ? 'CXNK' + fix(fsanMatch[1].substring(4)) : '';

    /* MACs, found without relying on the caption sitting next to the value.
     *
     * Vision returns text as observations, and on a label whose captions are
     * far from their values — the GS7 gateway, where the two are at opposite
     * edges — the entire caption column can arrive before the entire value
     * column. "MAC:" is then not followed by its number at all, so anchoring
     * on the caption finds nothing. That is exactly why a GS7's MAC came back
     * blank while its FSAN, which is matched anywhere in the text, came
     * through fine.
     *
     * A MAC is the only 12-character hex token these labels carry: the serial
     * number is all digits, the FSAN's CXNK prefix is not hex, and the WPA key
     * is 16 characters. On every Calix label seen so far the MTA MAC is the
     * primary MAC plus one, so sorting the pair recovers which is which
     * without needing the captions. */
    const macs = [...new Set(t.match(/\b[0-9A-F]{12}\b/g) || [])]
      .filter((m) => /[A-F]/.test(m))
      .sort();

    if (isOnt) {
      ont.sn = ont.sn || extract(/(?:SERIAL|S\/N)[^\dOIS]*([0-9OIS]{12})/) || extract(/(?:^|\s)([0-9OIS]{12})(?:\s|$)/);
      ont.mac = ont.mac || extract(/O[N0]U\s*M[A-Z]C[^\dA-Z]*([0-9A-Z]{12})/) || extract(/M[A-Z]C[^\dA-Z]*([0-9A-Z]{12})/) || macs[0] || '';
      ont.mta = ont.mta || extract(/MTA\s*M[A-Z]C[^\dA-Z]*([0-9A-Z]{12})/) || macs[1] || '';
      ont.fsan = ont.fsan || fsan;
    } else {
      router.mac = router.mac || extract(/(?:[^A-Z]|^)M[A-Z]C[^\dA-Z]*([0-9A-Z]{12})/) || extract(/M[A-Z]C[^\dA-Z]*([0-9A-Z]{12})/) || macs[0] || '';
      router.fsan = router.fsan || fsan;
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

  return template;
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
        // Apple's Vision engine, via the native shell. There is no model to
        // download and nothing to warm up, so this works with zero signal the
        // first time it is ever used — which the old bundled OCR did not.
        const texts = await recognizeText([...fileInput.files]);
        finalPayload = formatOcrToTemplate(texts);

      } else {
        const formData = new FormData();
        for (const file of fileInput.files) formData.append('images', file);
        const res = await fetch('/api/parse-equipment', { method: 'POST', body: formData });
        const data = await res.json();
        
        // Append a blank debug block if using AI to maintain structure
        finalPayload = data.text || formatOcrToTemplate([]);
      }
      
      const saved = await window.mercury.saveScan({
        payload: finalPayload,
        source: forceLocalEngine || !navigator.onLine ? 'offline' : 'ai'
      });

      renderResult(finalPayload, saved.id, saved.source);

    } catch (error) {
      console.error(error);
      // Surface the real reason when there is one — "needs the iOS app" and
      // "couldn't read that label" call for completely different responses.
      window.mercury.toast(
        error?.message || 'Scan failed. Try adjusting the photo lighting.',
        'danger', 8000);
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
    const text = decodeURIComponent(e.target.dataset.text).trim();
    navigator.clipboard.writeText(text);
    window.mercury.toast('Copied to clipboard!', 'success');
  }
});
