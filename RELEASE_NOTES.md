# GPT AntiCurse v0.5.17

History retry-storm fix, background-health diagnostics, and Firefox event-page hardening.

## Stop background retry storms

- Fixes a self-sustaining history-request loop exposed by a real Chrome debug report with hundreds of thousands of coalesced `runtime-request-failed` diagnostics.
- Root cause: the history controller reacted to every `storage.local` change. A failed request recorded a diagnostic, that diagnostic write triggered another history request, and the cycle repeated.
- History now reacts only to the three settings that actually affect it: `enabled`, `mode`, and `maxDisplayMessages`.
- Background history requests are single-flight, so overlapping triggers share one request.
- Transport failures use exponential cooldown from 1 second up to 30 seconds and recover immediately after a successful response/history delivery.

## Better Chrome service-worker diagnosis

- The Chromium service worker now registers a minimal `cg-background-health` listener before importing the rest of the worker modules.
- If an imported background module throws during startup, a debug report can still identify the worker as `import-failed` and include the startup error instead of only `Receiving end does not exist`.
- Debug reports separately record:
  - `packageTarget`: Chromium or Firefox package/manifest;
  - `runtimeBrowser`: actual Chrome/Chromium or Firefox browser from the browser UA;
  - `backgroundKind`: MV3 `service_worker` or background `scripts`;
  - live `backgroundHealth`.
- This removes ambiguity when extension package identity and the browser running it do not match.

## Firefox review and hardening

- Firefox history routing remains manifest/package based; Chromium-specific diagnostics do not alter the Firefox architecture.
- Firefox continues to synchronously attach `filterResponseData()` and waits for authoritative settings before transforming the buffered response.
- Firefox `storage.session` remains a fallback across nonpersistent background/event-page recreation, but large conversation history is no longer copied there on every successful response.
- The content script normally receives and retains the full history directly. The large history object is written to the 10 MB session fallback only when direct delivery misses during startup.
- Session fallback writes are serialized per key so a late write cannot race a newer remove/update.
- Firefox exposes the same background-health probe for diagnostics without changing its interception path.

## Regression coverage

- Adds an executable regression that reproduces the failed-request → diagnostic-storage-write feedback mechanism and fires 1,000 unrelated storage changes; the history request count must remain bounded.
- The same regression separately models Chromium package/Chromium runtime, Firefox package/Firefox runtime, and Firefox package executing in Chromium so package identity and runtime identity cannot be conflated again.
- Existing Chromium Recent/Auto, hydration, native-fidelity, Firefox interception/paging, and Firefox native-fidelity E2Es remain release gates.

## Privacy

- Health diagnostics contain browser/extension state and error metadata only, never conversation message text.
- No telemetry and no remote extension code.
