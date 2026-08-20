# GPT AntiCurse v0.6.8

Finalized long-conversation export reliability and technical-log fidelity, especially for Firefox and Firefox Android.

## Final export-fidelity polish after v0.6.7

- Preserves recognized structured plan payloads even when ChatGPT stores the plan record as visually hidden; arbitrary hidden assistant narration remains excluded.
- Corrects the Markdown header for **Full technical log** to describe its actual boundary: visible assistant records, structured plans, and explicit tool calls.
- Removes the unused export-detail field from the popup-to-content export request; formatting remains owned by the popup.
- Removes stale `archiveEnabled` writes from Chromium E2E fixtures now that continuous backup no longer exists.
- Updates the lifecycle evidence with the stronger real-browser reproduction: v0.6.6 dropped from a 630-record base to rendered-only state after the Firefox event page restarted, while the repaired path returned the complete 630-record export after the same restart.

## Fix: exports after Firefox background idle

- Fixes a v0.6.6 regression where **Full technical log**, **Readable conversation**, and other exports could contain only the few turns currently rendered in the page after the Firefox MV3 background event page had gone idle.
- The failure was reproduced against the released v0.6.6 build: before idle Export had a 630-record authoritative base; after about 45 seconds the Firefox background restarted and the same v0.6.6 export had `baseArchive=0` with only 6 currently rendered messages.
- The repaired build was tested under the same ~45-second idle/restart condition and returned the same complete 630-record authoritative export without reloading the chat.
- Export no longer depends on Firefox background-page globals or on a transient history delivery surviving until the user presses Export.

## Authoritative on-demand export

- Pressing Export now performs one fresh same-origin conversation request to ChatGPT using the browser's existing authenticated session. No continuous backup is reintroduced.
- The raw response is used only in memory for that export action, then discarded. Conversation text is still not persisted in extension storage.
- Chromium makes this request from the isolated extension world, so it is not passed through AntiCurse's MAIN-world response wrapper.
- Firefox uses an authenticated, random, one-shot bypass token scoped to the requesting tab and conversation. The private marker is stripped before the request reaches ChatGPT.
- Firefox also injects an internal response confirmation; an unconfirmed response is never labeled authoritative.
- The Firefox `StreamFilter` forwards the first export chunk and disconnects, allowing the rest of the explicitly requested export response to flow normally without buffering a second full copy in the background.
- If the authoritative request fails, export falls back to transient/rendered history and is explicitly marked partial instead of silently claiming completeness.

## Technical-log fidelity

- The on-demand raw-graph extractor preserves visible user/assistant history, recognized structured plan payloads, and explicit assistant tool calls with their `recipient` metadata, including supported technical records that ChatGPT marks visually hidden.
- Arbitrary hidden assistant narration is deliberately **not** surfaced by export.
- The normal performance/history archive remains lightweight and independent from the richer export snapshot.
- Raw technical records no longer confuse rendered-tail reconciliation: DOM turn indices are matched against a visible projection of the raw archive, so a currently streaming final response can extend the fresh endpoint snapshot without moving or duplicating interleaved tool calls.
- Chromium no longer loads the archive helper in ChatGPT's MAIN JavaScript world; MAIN keeps only the small visible-history builder needed for the history overlay.

## Completed-tool UI cleanup

- Already-hidden tool records are now left byte-for-byte untouched and are no longer counted as newly simplified.
- Removes the unnecessary `anticurse_simplified_technical` metadata field; only ChatGPT's existing visual-hidden metadata is used.
- Active tool runs, final answers, graph ancestry, roles, recipients, and message content remain unchanged.

## Regression analysis and tests

- Differential fuzzed v0.6.5 vs v0.6.6 across 5,000 randomized agent graphs: no unintended changes were found to retained node IDs, ancestry, roles, recipients, content, current node, or branch choice; differences were limited to the intended completed-tool visibility optimization.
- Added raw-export extraction tests and authenticated Firefox bypass tests, including forged-marker rejection and response-confirmation spoof protection.
- Chromium E2E now proves Export can recover an old explicit tool call that was absent from the page graph, and separately verifies the partial fallback path on an injected 503.
- Real Firefox testing verifies authenticated cookies survive the export request, the private marker never reaches the server, the filter disconnects once, and old/new tool calls are present while arbitrary hidden assistant narration stays excluded.
- Chromium export stress testing succeeded with a 35.4 MB raw conversation and a 33.8 MB generated Markdown result.
- Existing Chromium paging/hydration/native-fidelity and Firefox response-filter/native-fidelity tests remain green.
