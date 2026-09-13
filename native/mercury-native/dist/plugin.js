/* Placeholder web entry point.
 *
 * Mercury's packaged app loads the web UI from the live server rather than
 * from bundled assets, so the page reaches this plugin through the injected
 * global (window.Capacitor.Plugins.MercuryNative) and never imports this
 * file. It exists because npm expects package.json's "main" to resolve, and
 * because anything that does import it should fail loudly rather than get a
 * silent no-op that looks like a working OCR engine.
 */
'use strict';

const unavailable = () => {
  throw new Error(
    'MercuryNative is a native-only plugin. Call it via ' +
    'window.Capacitor.Plugins.MercuryNative inside the iOS app.',
  );
};

module.exports = { MercuryNative: { recognizeText: unavailable, savePhotos: unavailable } };
