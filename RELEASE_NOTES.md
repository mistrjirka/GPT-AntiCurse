# GPT AntiCurse v0.6.2

Code-quality, DOM-lifecycle, status, and popup clarity release after v0.6.1.

## Reliability and ownership

- Conversation stats now carry explicit conversation ownership, so a slow response from chat A cannot replace the visible status for chat B after SPA navigation.
- Chromium and Firefox cumulative optimization counters are separated from current-tab status ownership: completed trims still count even when their UI status is stale.
- Counter increments and Reset now share one serialized mutation path, preventing an older pending write from resurrecting totals after a reset.
- `maxPrefixNodes: 0` is now preserved correctly instead of being converted back to the default value.

## Simpler module composition

- Raw graph trimming is now an immutable `CGTrimCore`; logical Recent-N budgeting is a named `CGTrimLogical` policy; `trim-pipeline.js` is the single explicit production composition point.
- Removes the remaining logical-trimmer monkey-patch pattern.
- Removes the duplicate Markdown exporter from `CGArchive`; `CGArchiveExport` is the sole Markdown-export owner.
- Adds shared popup context helpers for active-tab, ChatGPT route, runtime/package identity, host access, and error formatting.

## DOM handling

- The bottom-right AntiCurse status is now a DOM singleton. Stale or duplicate status pills are removed, including duplicates inserted later by an older content-script instance.
- The archived-history host is likewise self-deduplicating so `#cg-window-history-host` remains unique.
- Dynamic status/history DOM uses explicit node creation and `textContent` instead of `innerHTML`; the fidelity layer also builds its SVG activity icon with SVG DOM APIs.
- Synthetic-history text copying uses `textContent` instead of layout-dependent `innerText`.
- Whole-document archive discovery observers are now temporary: once `#thread` is found, AntiCurse switches to narrower thread/parent/shell observers and re-enables broad discovery only when needed.

## Clearer popup and export UI

- When measurable, response payload reduction is now the primary optimization metric, shown in KB/MB/GB. Node-reduction percentage is used as the fallback when byte sizes are unavailable.
- The UI clarifies that this is response data removed from page state, not network bandwidth saved.
- Raw node counts, processing time, cumulative counters, and diagnostics are grouped under **Technical details**.
- Export choices are now named **Final answers only**, **Readable conversation** (recommended), and **Full technical log** while retaining the existing stored export modes.
- Persistent-backup status is simplified to **Ready**, **Partial**, **No backup**, or **Off**, with Partial explicitly warning that older history may be missing.

## Regression coverage

- Adds deterministic counter-reset ordering coverage.
- Adds Chromium and Firefox chat A → B stale-stat tests.
- Adds a regression test for duplicate bottom-right status nodes.
- Adds architecture gates for explicit trim composition, safe DOM construction, temporary discovery observers, and exclusive archive-export ownership.
- Chromium Recent/Auto, hydration-boundary, native-fidelity, Firefox interception/paging, and Firefox native-fidelity E2E remain release gates.

## Privacy

- No telemetry or remote extension code.
- Conversation processing and archives remain local to the browser.
