# GPT AntiCurse v0.7.3

Compatibility and recovery fixes for ChatGPT's current paginated conversation format.

## Current ChatGPT conversation format

- Supports the current plural conversation response shaped as `messages` + `page_info` in both Firefox and Chromium.
- Applies the normal logical/technical-state trimmer to that raw message list, so internal tool/progress records are actually removed instead of only suppressing the pagination cursor.
- Restores meaningful **Internal nodes removed** and measured payload-reduction counters for the new response shape.
- Fetches older history through ChatGPT's current `/conversations/<id>/messages?before=...` pagination route while keeping those raw older pages out of ChatGPT's active React state.
- Keeps the older singular/mapping endpoint compatible as a fallback.

## History and popup

- **Auto window** is now the default history mode for fresh installs. Existing saved mode choices are preserved on upgrade.
- Fixes Firefox popup intrinsic sizing so the popup cannot collapse to effectively zero width; narrow touch layouts retain a dedicated mobile override.

## Stalled-run recovery

- Adds a live bottom-right countdown such as `auto-continue in 1:42`, including the longer active-tool deadline and checking/confirming/resuming states.
- Fixes recovery when ChatGPT leaves the Send button disabled while the composer is empty: AntiCurse now stops the run, inserts `.`, waits for Send to become usable, and then submits it.
- Removes the page-reload recovery fallback entirely. If Send never becomes usable, AntiCurse leaves the page in place and fails safely.
- Existing draft/attachment, visible-tab, one-attempt-per-turn, long-wait-banner, and backend `IS_STREAMING` safeguards remain.

## Regression coverage

- Chromium and Firefox E2Es exercise the current raw plural document response and the `/messages?before=` continuation route.
- Stall-recovery E2Es include the real failure mode where Send starts disabled and only becomes enabled after the `.` input event; both browsers must recover without reloading.
- Native-history fidelity, hydration, packaging, endpoint, export-bypass, and logical-trimming coverage remains in place.
