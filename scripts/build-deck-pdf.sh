#!/usr/bin/env bash
# Render public/deck/index.html to private/deck.pdf using headless Chrome.
# The site at /deck.pdf 302s to /deck (email-gated viewer). The viewer streams
# the PDF from /api/deck/file, which checks the signed `ak_deck` cookie and
# reads the file from private/ — outside the static-served public/ tree.
# Zero deps: relies on macOS system Chrome / Chromium / Edge.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INPUT="$ROOT/public/deck/index.html"
OUTPUT="$ROOT/private/deck.pdf"
mkdir -p "$(dirname "$OUTPUT")"

# Find a usable headless-capable Chromium browser.
CHROME=""
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"; do
  if [[ -x "$candidate" ]]; then CHROME="$candidate"; break; fi
done

if [[ -z "$CHROME" ]]; then
  echo "No headless-capable Chromium browser found." >&2
  exit 1
fi

echo "Using browser: $CHROME"
echo "Rendering $INPUT → $OUTPUT"

TMPDIR_CHROME="$(mktemp -d -t agentkarma-pdf)"
trap 'rm -rf "$TMPDIR_CHROME"' EXIT

"$CHROME" \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --hide-scrollbars \
  --user-data-dir="$TMPDIR_CHROME" \
  --virtual-time-budget=8000 \
  --run-all-compositor-stages-before-draw \
  --default-background-color=00000000 \
  --no-pdf-header-footer \
  --print-to-pdf-no-header \
  --print-to-pdf="$OUTPUT" \
  "file://$INPUT"

if [[ -f "$OUTPUT" ]]; then
  size=$(stat -f%z "$OUTPUT" 2>/dev/null || stat -c%s "$OUTPUT")
  echo "PDF written: $OUTPUT ($size bytes)"
else
  echo "PDF render failed." >&2
  exit 1
fi
