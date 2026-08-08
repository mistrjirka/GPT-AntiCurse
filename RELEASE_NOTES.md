# GPT AntiCurse v0.3.0

UI, diagnostics, and installation improvements.

## New

- Redesigned Firefox and Chromium popup with a clearer long-chat performance dashboard.
- Shows the percentage of the conversation mapping removed on the last load.
- Shows internal mapping nodes removed and visible user/assistant turns preserved.
- Firefox shows the actual response-byte reduction because its stream filter sees the original response bytes directly.
- Adds cumulative local counters for optimized loads, nodes skipped, and measurable bytes removed, with a reset button.
- Redesigned in-page status pill with a compact `AntiCurse · N% trimmed` summary.
- Added a plain-language **How it works** explanation in the popup and README.
- Added detailed permanent Firefox installation instructions covering AMO installs, signed XPI installation, self-distribution signing, and temporary development installs.

## Chrome / Chromium

- Adds a small MV3 service worker used only to safely aggregate cumulative numeric counters across tabs.
- Conversation interception remains in the packaged `MAIN`-world script at `document_start`.

## Privacy

No telemetry or conversation content is collected. All transformation and counters remain local to the browser. Cumulative counters contain numeric totals only.
