# GPT AntiCurse v0.5.12

Chromium history reliability, hydration safety, and code-quality cleanup for very long chats.

## Chromium / Manifest V3

- Fixes the real long-chat case where graph trimming succeeded but **Load previous** and **Auto window** received no usable archive.
- Replaces repeated MAIN-world full-history replay with one transient current-page archive and a durable extension-origin IndexedDB fallback.
- Uses normal extension `runtime.sendMessage()` for the durable history fallback instead of keeping conversation history in MV3 service-worker globals.
- The MV3 service worker is stateless with respect to conversation history; a worker suspension/restart cannot erase the archive source.
- Collapses the Chromium conversation transport to one scoped `Response.json()` / `Response.text()` interceptor instead of stacking two wrappers whose ordering affected correctness.

## React hydration

- The interceptor still installs at `document_start`, so ChatGPT cannot consume the full graph before AntiCurse is ready.
- On server-rendered hard loads, the transformed conversation is held until authoritative settings are known and the initial hydration boundary has settled.
- If that startup boundary cannot settle within the bounded timeout, AntiCurse fails open and leaves the original conversation unchanged instead of risking another React hydration mismatch (`#418`).
- AntiCurse-owned DOM remains gated separately until the hydrated page is safe to modify.

## Recent N and Auto window

- The product now has only the two supported bounded modes internally as well as in the popup: **Recent N + button** and **Auto window**.
- Removes the dead legacy `visible-history` and `latest-visible` graph-selection paths.
- If ChatGPT initially positions a trimmed conversation away from its current/end position, AntiCurse corrects it once before user interaction.
- Current-page history is available independently of whether optional persistent Conversation Backup is enabled.
- The archived-history renderer remains bounded/virtualized and keeps synthetic history outside ChatGPT's React-owned graph.

## Failure visibility

- History/archive failures no longer silently look like "there are no older messages."
- IndexedDB failures, runtime-message failures, archive construction failures, unsupported conversation shapes, and "trim succeeded but no history reached the UI" are recorded as local diagnostics.
- The on-page AntiCurse status and popup can surface recent local issues.
- Normal absence of a persistent archive remains distinct from an actual storage/runtime error.

## Performance and code quality

- Removes obsolete history replay/request/overlay code and the duplicate Firefox pre-trim archive hook.
- Removes permanent history reattachment polling; history attachment is event-driven.
- Moves incremental DOM backup observation behind hydration and scopes it to `#thread` instead of observing the entire ChatGPT document from `document_start`.
- Keeps only the final ~96 rendered turns in the incremental DOM backup scan.
- Adds a packaging-reachability test so unused JavaScript/CSS cannot silently remain in release ZIPs.
- Adds a production audit that rejects empty `catch {}` / `.catch(() => {})` patterns, removed runtime modes, and permanent history polling.

## Regression coverage

- Real Chromium extension E2E: Recent N, Load previous, Auto window, bounded virtualization, technical-node preservation, and current/end positioning.
- Real Chromium SSR/hydration E2E.
- Real Chromium native-history-fidelity E2E.
- Real Firefox network-filter/paging E2E.
- Real Firefox native-history-fidelity E2E.
- Existing trim, archive, Markdown export, virtualization, and browser-parity unit tests remain release gates.

## Privacy

- No telemetry and no remote extension code.
- Conversation processing, optional archive storage, diagnostics, counters, history rendering, and Markdown export remain local to the browser.
