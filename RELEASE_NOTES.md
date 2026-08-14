# GPT AntiCurse v0.5.11

Hydration-safe history UI for ChatGPT's server-rendered pages.

## React hydration

- Fixes a React hydration mismatch (`Minified React error #418`) caused by AntiCurse inserting extension-owned DOM into ChatGPT's server-rendered React tree before hydration had settled.
- The conversation graph interceptor still runs at `document_start`, so trimming remains early and effective.
- AntiCurse-owned UI DOM is now gated until the page `load` boundary, two animation frames, and an idle slice (with a bounded timeout).
- History payloads received before that boundary are buffered and applied afterward rather than being dropped.
- The on-page status badge follows the same hydration-safe boundary.

## History behavior

- Recent N + button and Auto window are unchanged after hydration completes.
- Chromium's retained-history replay from v0.5.10 remains in place, so delaying the UI does not lose the archived conversation payload.
- Native-looking archived rendering and bounded virtualization remain unchanged.

## Regression coverage

- Adds a real Chromium hydration-boundary E2E fixture with server-rendered conversation HTML and a deliberately delayed page-load resource.
- The test proves that conversation trimming already happened while both `#cg-window-history-host` and the AntiCurse status badge are still absent.
- It then verifies that the history control and status UI appear only after the hydration-safe boundary.
- Existing Chromium and Firefox paging, virtualization, and native-fidelity E2E tests remain release gates.

## Privacy

- No telemetry or remote extension code.
- Conversation archives, counters, history rendering, and Markdown exports remain local to the browser.
