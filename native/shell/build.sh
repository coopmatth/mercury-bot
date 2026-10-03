#!/bin/bash
# Assemble the bundled iOS app shell in native/shell/www/.
#
# The iOS webview exposes no service worker, so the app cannot rely on a
# cached server-rendered site for offline cold starts. Instead the IPA
# bundles this self-contained shell: it paints instantly from the on-device
# IndexedDB replica and syncs through the API whenever there is signal.
#
# Single source of truth: CSS and shared JS modules are copied from the
# repo at build time. Only index.html and js/shell.js live here.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SHELL_DIR="$REPO_ROOT/native/shell/www"

mkdir -p "$SHELL_DIR/css" "$SHELL_DIR/js"

cp "$REPO_ROOT/static/css/app.css" "$SHELL_DIR/css/app.css"

# Shared modules. app.js is excluded on purpose: its seamless-navigation
# router assumes server-rendered pages. sw.js is excluded: no service
# worker in the iOS webview.
for mod in store.js sync.js rates.js local.js hydrate.js native.js; do
  cp "$REPO_ROOT/static/js/$mod" "$SHELL_DIR/js/$mod"
done

# The shell talks to the server API cross-origin (capacitor://localhost),
# which the API allows via CORS for the app's own origins.
echo "shell assembled: $(ls "$SHELL_DIR/js" | tr '\n' ' ')"
