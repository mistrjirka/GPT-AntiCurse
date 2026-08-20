# GPT AntiCurse v0.6.6

JavaScript/React load reduction for tool-heavy agent conversations, plus memory-only on-demand export.

## Cheaper completed agent turns

- Targets ChatGPT's expensive rich tool UI rather than only shrinking the recent-message window.
- When the retained conversation contains a pathological completed agent workload (12 or more completed tool calls), AntiCurse keeps the technical graph records, payloads, roles, recipients, and ancestry intact but marks completed tool-call/result records non-visual before ChatGPT processes the response.
- The final assistant answer remains native and visible.
- The current/latest exchange is simplified only when the response carries an explicit completion signal (`end_turn`, a completed status, or finish details). Active/in-progress tool runs are left untouched.
- Small tool runs stay unchanged and retain their native tool cards.
- New diagnostics report whether rich technical UI was simplified and how many completed tool calls/results were affected.

In the synthetic mobile-style Playwright/React stress fixture used during development, keeping the same 132 graph nodes while making completed technical records non-visual reduced median JavaScript scripting time by about 41% and total task time by about 38% at 4× CPU throttling. This is benchmark evidence for the optimization mechanism, not a guarantee of the same speedup on every ChatGPT build or phone.

## Export is now fully on demand

- Removes continuous conversation backup, live backup MutationObservers, periodic rendered-tail hashing/merging, pagehide backup work, and conversation IndexedDB persistence.
- Markdown export now captures an in-memory snapshot only when **Download Markdown** or **Download & new chat** is pressed.
- The export snapshot combines the untouched transient conversation history with the currently rendered tail, generates Markdown locally, and is then discarded.
- Chromium still keeps a transient current-page history snapshot so **Load previous** works without delivering old turns to React.
- Firefox continues to serve older history from its per-tab response cache.
- Removes the `unlimitedStorage` permission and the archive-store/background persistence modules.

## Status and diagnostics

- Loads that only simplify completed rich tool UI now report that optimization directly instead of misleadingly showing `0% trimmed`.
- Debug state identifies export as `on-demand` and reports no persistent backup mode.

## Regression coverage

- Adds graph-preservation tests for completed technical UI simplification, including protection for active tool runs and small normal tool exchanges.
- Chromium E2E verifies that explicit memory-only export can still recover old history that was never delivered to ChatGPT's React tree.
- Existing Chromium hydration/fidelity, Firefox response-filter/fidelity, Android compatibility, packaging, and code-quality checks remain release gates.
