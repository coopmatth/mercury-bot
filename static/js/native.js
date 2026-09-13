/* Bridge to the packaged iOS app's native code.
 *
 * The app is a Capacitor shell that loads this site from the server rather
 * than from bundled assets, so there is no npm import to reach for: Capacitor
 * injects window.Capacitor into the web view before any page script runs, and
 * the plugin appears under Plugins.MercuryNative. In an ordinary browser — and
 * in the installed PWA — none of that exists, so every helper here reports
 * unavailable and callers fall back to what the web can do on its own.
 *
 * Everything is resolved at call time, never cached at module load: the same
 * page is served to the app and to the browser, and only the app has a bridge.
 */

/** The native plugin, or null when running anywhere but the packaged app. */
export function nativePlugin() {
  return window.Capacitor?.Plugins?.MercuryNative || null;
}

/** True inside the packaged iOS app, false in a browser or the PWA. */
export function isNativeApp() {
  return nativePlugin() !== null;
}

/** A blob as bare base64 (no data: prefix) — what the plugin expects. */
function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That photo could not be read.'));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/* Vision reads small print well, but every pixel crosses the JS-to-native
 * bridge as base64, so a 12 MP original costs far more in transfer than it
 * returns in accuracy. 2400px on the long edge keeps label text crisp while
 * holding each photo to a few hundred KB. Images already smaller than that
 * are passed through untouched rather than upscaled. */
const OCR_MAX_EDGE = 2400;
const OCR_QUALITY = 0.9;

async function downscaleForOcr(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, OCR_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  return new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', OCR_QUALITY));
}

/**
 * Read text from each image with Apple's on-device Vision engine.
 * Returns one string per input file, in order — an unreadable photo yields
 * an empty string rather than shifting the rest.
 * @param {File[]|Blob[]} files
 * @returns {Promise<string[]>}
 */
export async function recognizeText(files) {
  const plugin = nativePlugin();
  if (!plugin) throw new Error('On-device reading needs the Mercury iOS app.');

  const images = [];
  for (const file of files) {
    images.push(await toBase64(await downscaleForOcr(file)));
  }

  const result = await plugin.recognizeText({ images });
  return result?.texts || [];
}

/**
 * Save images straight to the camera roll.
 * @param {Blob[]} blobs
 * @returns {Promise<number>} how many were saved
 */
export async function savePhotos(blobs) {
  const plugin = nativePlugin();
  if (!plugin) throw new Error('Saving to the camera roll needs the Mercury iOS app.');

  const images = [];
  for (const blob of blobs) images.push(await toBase64(blob));

  const result = await plugin.savePhotos({ images });
  return result?.saved ?? images.length;
}
