# GPT AntiCurse v0.4.2

History paging, auto-scroll detection, and source-reviewability update.

## History loading

- Auto windowed history now targets ChatGPT's explicit `data-scroll-root` element instead of relying only on ancestor overflow detection.
- Reaching the top while scrolling upward opens the older-history reader automatically.
- A further upward wheel gesture at `scrollTop = 0` is handled explicitly because no additional native `scroll` event is generated at that point.
- **Load previous N** is now available as a manual fallback in every limited-history mode.
- Latest visible only and Recent safe window now also keep the lightweight local visible-message archive required by manual paging.
- The older-history reader has its own **Load previous N** button and continues to auto-page near its top.

## UI

- Replaced the dashboard-style popup with a smaller, more minimal control panel.
- Common controls and the main graph-reduction number stay visible.
- Detailed counters moved behind a collapsed **Details** section.
- Popup CSS is now a separate source file instead of a large inline style block.

## Graph logic fix

- Fixed the recent-window cutoff when a conversation contains fewer than N visible turns but still has off-branch nodes. The old implementation could choose the final node as the cutoff; it now correctly keeps the entire active chain while pruning the off-branch state.
- Added a regression test for this case.

## Source reviewability

- Split history rendering into `history-overlay.js` and scroll detection/control into `windowed.js`.
- Refactored the Firefox response interceptor and Chromium response interceptor into small named helpers.
- Refactored the pure graph transformation code so selection, cutoff calculation, rebuilding, and statistics are separate functions.
- Formatted the test suite into named tests.
- Added `REVIEWING.md` with the runtime flow, source map, security/privacy properties, and validation process.
- Release CI now syntax-checks every shipped JavaScript file, verifies shared Firefox/Chromium modules are identical, rejects `eval`/`Function` dynamic execution, and runs graph regression tests before packaging.

## Privacy

No telemetry or conversation data is transmitted. Trimming, older-history archives, paging, and counters remain local to the browser.
