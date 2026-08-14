# GPT AntiCurse v0.5.15

Reliability, Manifest V3 lifecycle, and debugging audit.

## Failure recovery

- Chromium counter serialization now recovers after a failed storage operation instead of leaving every later counter update attached to a permanently rejected Promise.
- IndexedDB initialization no longer caches a rejected open forever. Transient open/blocked failures can be retried, and version changes close/reset the cached connection.
- Archive persistence queues remain self-healing after a failed operation.
- Removes the background archive helper's tab-to-conversation fallback global; archive reads now require the explicit conversation id already supplied by the content script.

## Firefox MV3 lifecycle

- Firefox response filtering now waits for authoritative stored settings before deciding whether to trim a newly loaded conversation.
- A background/event-page wakeup can therefore no longer process the first conversation with startup defaults before the user's saved settings have loaded.
- If settings storage cannot be read, the Firefox interceptor fails open and returns the original response with a diagnostic.
- Per-tab Firefox stats/history now have `storage.session` fallback in addition to hot memory, so event-page unload/recreation does not silently erase the history fallback.
- Session-cache failures, including quota/storage failures, are explicit diagnostics rather than indistinguishable `archive-not-found` states.

## DOM/background overhead

- Removes the archive tail updater's permanent 100 ms `#thread` polling loop and replaces it with mutation-driven discovery/re-attachment.
- DOM tail observers are not installed while persistent conversation backup is disabled.
- Tail text extraction uses `textContent` instead of `innerText`, avoiding unnecessary synchronous layout work.
- Hydration-ready callbacks now report rejected/throwing callbacks instead of creating unhandled Promise rejections.

## Debugging

- Keeps a bounded local history of the most recent 24 AntiCurse diagnostic issues, with repeated identical issues collapsed into a count.
- Adds **Download debug report** under Details.
- The report actively checks the live content-script bridge, current settings, hydration/DOM state, native thread/scroller state, AntiCurse history host/button state, transient archive state, background history source/counts, archive summary, counters, and recent diagnostic history.
- Debug reports contain health metadata and identifiers only; they do not include conversation message text.

## Regression coverage

- Adds lifecycle/failure-recovery tests for poisoned Promise queues, IndexedDB retry behavior, permanent DOM polling, Firefox settings initialization, session history fallback, diagnostic history, and debug-state packaging.
- Existing real Chromium Recent/Auto, hydration and native-fidelity E2Es remain release gates.
- Existing real Firefox interception/paging and native-fidelity E2Es remain release gates.
- Dead-code, silent-catch, package reachability, cross-browser parity, archive/export and virtualization checks remain enabled.

## Privacy

- No telemetry and no remote extension code.
- Conversation processing, optional archive storage, diagnostics, debug reports, counters, history rendering and Markdown export remain local to the browser.
