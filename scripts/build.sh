#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="$(command -v python3 || command -v python)"
VERSION="$("$PYTHON" -c 'import json; print(json.load(open("'"$ROOT"'/firefox/manifest.json"))["version"])')"
CHROME_VERSION="$("$PYTHON" -c 'import json; print(json.load(open("'"$ROOT"'/chrome/manifest.json"))["version"])')"
[[ "$VERSION" == "$CHROME_VERSION" ]] || { echo "Manifest versions differ" >&2; exit 1; }
rm -rf "$ROOT/dist"
mkdir -p "$ROOT/dist"
(cd "$ROOT/firefox" && zip -qr "$ROOT/dist/gpt-anticurse-firefox-v${VERSION}.zip" .)
(cd "$ROOT/chrome" && zip -qr "$ROOT/dist/gpt-anticurse-chrome-v${VERSION}.zip" .)
echo "Built v$VERSION in $ROOT/dist"
