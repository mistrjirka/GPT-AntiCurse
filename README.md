# GPT AntiCurse

GPT AntiCurse is a browser extension for keeping very long ChatGPT conversations responsive. It intercepts conversation data before ChatGPT processes it, keeps only a bounded recent graph in the page, and makes older visible history available through an extension-owned history layer.

## What it does

- Shrinks large ChatGPT conversation graphs before the page processes them.
- Preserves a recent user-facing window while keeping required technical/hidden graph state inside that recent slice.
- Offers two history modes:
  - **Recent N + button** — keep the latest window natively and load older turns explicitly.
  - **Auto window** — automatically load an older page when you reach the top.
- Keeps archived history outside ChatGPT's React-owned conversation graph and bounds the amount of archived DOM mounted at once.
- Can keep an optional persistent local conversation backup for Markdown export.
- Provides local diagnostics/debug reports without conversation text.

## Browser architecture

### Firefox

Firefox uses `webRequest.filterResponseData()` to capture and transform the conversation response before ChatGPT receives it. The event-page background keeps durable/session fallbacks for history and status without relying on globals surviving background suspension.

### Chromium

Chromium installs one MAIN-world response interceptor at `document_start` and keeps DOM/history/status code in the isolated content-script world. Conversation transformation waits for settings plus an initial hydration/load safety boundary before changing SSR-delivered conversation data.

## Conversation ownership

ChatGPT is a long-lived SPA, so one browser tab may visit many conversations without reloading. AntiCurse treats conversation identity as explicit state rather than equating a tab with a conversation:

- async history work carries a conversation-scope token;
- background history and stats payloads carry `conversationId`;
- stale responses for a previous SPA conversation are rejected before they can update current UI/history;
- persistent archives are stored by conversation ID rather than by tab;
- cumulative optimization counters remain independent of whichever conversation currently owns the tab UI.

## Local backup and export

Persistent backup is optional. When enabled, AntiCurse stores a local archive in extension-origin storage so the chat can still be exported after a reload.

The popup offers three export detail levels:

- **Final answers only** — user messages and final assistant answers.
- **Readable conversation** — recommended; keeps readable assistant progress/plans while omitting raw tool-call noise.
- **Full technical log** — includes raw tool calls and plan payloads for debugging or technical continuation.

The underlying stored export mode values remain `clean`, `progress`, and `full` for compatibility.

## Limitations

- Chromium interception is inherently more dependent on page internals than Firefox's network-level stream filtering.
- A Markdown export is intended as continuation context; AntiCurse cannot force a new model conversation to have the original model's hidden state.

## Source layout

The production extension is intentionally plain, human-readable JavaScript/CSS/HTML with no bundling or minification.

Important files include:

- `trim.js` — immutable browser-independent raw graph trimming (`CGTrimCore`).
- `trim-logical.js` — named logical Recent-N budgeting policy (`CGTrimLogical`).
- `trim-pipeline.js` — explicit production composition point publishing `CGTrim`.
- `archive.js` / `archive-store.js` — archive normalization/merging and durable local storage.
- `archive-export.js` — named Markdown export module and sole owner of Markdown export formatting.
- `history-markdown.js` — lightweight Markdown rendering for archived turns.
- `history-virtualized.js` — bounded archived-history DOM window and spacers.
- `history-fidelity.js` — decorator that adapts archived turns to the current native ChatGPT visual shell.
- `history-hydration-safe.js` — decorator that prevents archived DOM changes before hydration settles.
- `history-overlay.js` — explicit composition point for the virtual renderer and its decorators.
- `windowed.js` — recent/auto history controller, conversation scoping, and scroll-root handling.
- `popup-context.js` — shared popup environment helpers without merging browser-specific permission/save behavior.
- `firefox/background.js` — Firefox response interception and event-page state.
- `chrome/main.js` — Chromium conversation-response transformation and startup/hydration safety barrier.

There is no minification, transpilation, bundling, `eval`, `new Function`, or remotely loaded JavaScript in the extension.

Build the production packages with:

```bash
bash ./scripts/build.sh
```

The script directly ZIPs the existing `firefox/` and `chrome/` source directories.

## Testing

Release CI validates both browser packages, checks JavaScript syntax and shared-source parity, rejects dynamic code execution, and runs unit/code-quality tests for trimming, archives, exports, diagnostics, counter ordering, conversation-scoped status, history virtualization, and history rendering.

It also launches real browser extensions in CI:

- Chromium E2E for response trimming, paging, Auto window, and bounded archive DOM.
- Chromium hydration-boundary E2E.
- Chromium native-fidelity E2E using a ChatGPT-shaped turn shell.
- Firefox E2E through the real `webRequest.filterResponseData()` path.
- Firefox native-fidelity E2E.
