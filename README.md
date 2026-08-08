# GPT AntiCurse

GPT AntiCurse makes very long ChatGPT conversations responsive by reducing the client-side conversation graph **before ChatGPT's expensive state traversal processes it**.

It was built after Firefox Profiler captures of a pathological long chat showed repeated nested JavaScript traversal through ChatGPT conversation-state functions. In the first prototype, cutting roughly 4,500 mapping nodes down to a tiny graph made the affected tab dramatically faster. The current default is less destructive: it keeps the visible user/assistant history on the active branch while removing the bulk of tool, system, and explicitly-hidden state nodes.

## How it works — in normal language

A ChatGPT conversation is not stored in the browser as only the messages you can see.

A long chat can contain **thousands of internal conversation nodes**: tool calls, tool results, system state, hidden messages, and branching/history bookkeeping. ChatGPT's frontend repeatedly walks and transforms this conversation graph. On very long chats, those repeated JavaScript traversals can become extremely expensive even though only a much smaller number of messages are actually visible.

GPT AntiCurse changes the input instead of trying to patch JavaScript loops afterwards:

1. ChatGPT asks the server for the conversation.
2. AntiCurse intercepts that conversation response locally in the browser.
3. It follows the active conversation branch and identifies the visible user/assistant turns.
4. Depending on the selected mode, it removes unnecessary tool/system/explicitly-hidden graph nodes and/or limits the native conversation window.
5. ChatGPT receives a much smaller graph, so its normal frontend code has far less data to repeatedly traverse.

In **All visible history** mode, the goal is to keep the visible conversation scrollable all the way to the beginning while discarding internal state that makes the graph huge.

In **Latest visible only**, ChatGPT itself receives only the newest N visible user/assistant turns. Hidden/tool/system nodes do not consume that N-turn window.

In **Auto windowed history**, the newest N visible turns remain in the normal ChatGPT UI. AntiCurse separately keeps a lightweight archive of older visible turns and inserts them in small batches when you scroll upward. When you move far enough away, distant injected batches are removed again; scrolling back reloads them. This keeps both ChatGPT's private conversation graph and the extension-rendered DOM bounded.

AntiCurse does **not** modify the server-side conversation. The trimming happens locally for the response delivered to that browser tab.

## What the counters mean

The popup and, optionally, the small in-page status pill show measurements from the actual conversation response:

- **Conversation graph trimmed** — percentage of mapping nodes removed before ChatGPT processes the response.
- **Internal nodes removed** — mapping nodes AntiCurse did not deliver to the page.
- **Visible turns preserved** — user/assistant turns kept for the native ChatGPT UI.
- **Response bytes removed** — JSON payload reduction when that transport can be measured directly (Firefox can measure this precisely).
- **Since install / reset** — cumulative optimized loads, nodes skipped, and measurable response bytes removed.

The floating `AntiCurse · N% trimmed` notice can be disabled independently in the popup with **Show on-page status notice**. Disabling it does not disable the guard or the popup statistics.

These counters deliberately do **not** claim a CPU percentage saved. They measure the graph/data removed; actual CPU improvement depends on the conversation and ChatGPT frontend version.

## Modes

### All visible history (default)

- Follow the active `current_node` ancestry.
- Keep every non-hidden `user` / `assistant` display candidate.
- Drop tool, system, explicitly-hidden, and off-branch state nodes.
- Reconnect the kept nodes as a short linear graph.
- Preserve `current_node`.
- Uses ChatGPT's native UI for the entire retained visible history.

### Latest visible only

- Keep only the newest N visible user/assistant turns.
- Tool, system, and explicitly-hidden nodes do **not** consume the N-turn quota.
- Drop older visible history from the page response as well.
- This is the smallest/simple native ChatGPT graph and is useful when maximum responsiveness matters more than scrolling far back.

### Auto windowed history (experimental)

- Give ChatGPT only the newest N visible user/assistant turns, just like **Latest visible only**.
- Keep a separate lightweight archive containing only older visible user/assistant content.
- As you approach the top, load an older batch automatically.
- Keep only a bounded number of injected older turns in the DOM.
- When scrolling toward newer history, load missing newer batches and unload distant older batches.
- The newest N turns remain fully native ChatGPT messages.

The virtualized older history is intentionally a lightweight reader. Plain text is preserved; some rich historical content such as interactive tool widgets, complex attachments, rendered artifacts, or ChatGPT-specific formatting can appear as simplified text/placeholders. This mode never restores hidden/tool/system nodes to ChatGPT's React state.

### Recent safe window

Keep the newest N visible user/assistant messages **plus the internal nodes between them**. Tool nodes do not consume the N-message quota, but unlike **Latest visible only**, the interstitial state is deliberately retained. This is useful as a compatibility fallback if a ChatGPT feature depends on those recent internal nodes.

## Installation

### Firefox — normal permanent installation

For normal Firefox Release/Beta, extensions must be **signed by Mozilla**. A temporary `about:debugging` install disappears when Firefox restarts; an unsigned GitHub ZIP cannot be made permanent on normal Release Firefox just by moving it somewhere.

**Recommended:** install the signed release from the Firefox Add-ons (AMO) listing once the current version is approved/signed. An AMO installation persists across restarts and can receive normal updates.

Mozilla signing documentation:

- https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/

### Firefox — install a signed XPI from disk

A signed self-distributed build is also permanent:

1. Obtain a Mozilla-signed `.xpi` for GPT AntiCurse.
2. Open `about:addons` in Firefox.
3. Click the gear menu.
4. Choose **Install Add-on From File…**.
5. Select the signed `.xpi` and confirm **Add**.

Mozilla documents this installation method here:

- https://extensionworkshop.com/documentation/publish/install-self-distributed/

For development/self-distribution, Mozilla can sign an unlisted build through AMO or `web-ext`:

```bash
web-ext sign --channel=unlisted \
  --api-key="$AMO_JWT_ISSUER" \
  --api-secret="$AMO_JWT_SECRET"
```

That command returns a signed XPI suitable for permanent installation. See:

- https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/#sign-your-extension-for-self-distribution

### Firefox — unsigned development build

The GitHub Firefox ZIP can always be tested temporarily:

1. Unzip the Firefox package.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…**.
4. Select `manifest.json` from the extracted package.

Mozilla documents that temporary extensions stay installed only until removal or Firefox restart:

- https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/

Developer Edition, Nightly, and ESR can allow unsigned extensions by changing `xpinstall.signatures.required`, but normal Firefox Release/Beta still requires Mozilla signing. This is intended for development, not ordinary distribution.

### Chrome / Chromium

For local use:

1. Unzip the Chrome package.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the extracted package directory.

The unpacked extension remains configured across browser restarts unless removed/disabled, though Chromium may show developer-mode warnings. General public distribution should use the Chrome Web Store.

## Downloads

GitHub Releases contain separate packages for:

- `gpt-anticurse-firefox-v*.zip`
- `gpt-anticurse-chrome-v*.zip`

The GitHub Firefox ZIP is an **unsigned development package** unless explicitly stated otherwise in a release. Normal Firefox requires a Mozilla-signed XPI for permanent installation.

## Firefox architecture

Firefox gets the strongest implementation. The extension uses `browser.webRequest.filterResponseData()` on the exact `/backend-api/conversation/<id>` response, parses it, reduces the mapping and writes the smaller JSON stream back before ChatGPT page JavaScript receives it.

For **Auto windowed history**, Firefox also extracts only the visible user/assistant content from the original response before trimming it. That lightweight visible archive is kept inside the extension for the current tab and is used by the scroll-window renderer; it is never sent to an external service.

Mozilla documentation:

- `filterResponseData()`: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/filterResponseData
- `StreamFilter`: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/StreamFilter

## Chrome / Chromium architecture

Chrome Manifest V3 does not offer Firefox's response-stream body filter to normal extensions. Chrome also documents that `webRequestBlocking` is unavailable to most Manifest V3 extensions; policy-installed extensions are the exception.

The Chromium build therefore uses the same transformation at a different boundary:

1. A packaged content script runs at `document_start` in the `MAIN` execution world.
2. It wraps native `Response.prototype.json()` and `Response.prototype.text()`.
3. Only responses whose URL exactly matches the ChatGPT conversation-document endpoint are considered.
4. The parsed object is reduced before the ChatGPT application receives it.
5. Extension settings remain in the isolated extension world and are bridged with `window.postMessage`.
6. A small extension service worker keeps cumulative counters without sending data anywhere.
7. In Auto windowed mode, the MAIN-world interceptor passes only the lightweight visible-history archive to the isolated extension renderer via `window.postMessage`.

Chrome documentation:

- MV3 blocking-web-request migration: https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests
- `chrome.webRequest`: https://developer.chrome.com/docs/extensions/reference/api/webRequest
- content-script `world: "MAIN"` and `run_at: "document_start"`: https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts

The Chrome path is necessarily less robust than Firefox's network-level response filter. If ChatGPT stops consuming the conversation through Fetch `Response.json()` / `text()`, the Chrome interception will need adapting.

## Why not patch `Array.prototype.forEach`?

The profiler showed `forEach` as a hot leaf inside recursive conversation-state traversal. Globally replacing `Array.prototype.forEach` would affect unrelated application code and would not fix the underlying oversized graph. GPT AntiCurse instead reduces the input graph that those traversals repeatedly process.

Relevant React documentation:

- rendering work is recursive: https://react.dev/learn/render-and-commit
- repeated expensive collection transformations can warrant memoization: https://react.dev/reference/react/useMemo
- avoid unnecessarily deeply nested state: https://react.dev/learn/choosing-the-state-structure

These React references explain the general performance principles; the evidence that this specific ChatGPT graph is pathological comes from the supplied Firefox profiles.

## Privacy

- No analytics or telemetry.
- No conversation data is sent to the extension developer or another server.
- Trimming, virtual-history extraction/rendering, and counters are processed locally in the browser.
- Cumulative counters contain numeric totals only, not message contents.
- Auto windowed history keeps its lightweight visible-message archive only inside the running browser extension/tab state; it is not written to telemetry or uploaded anywhere.

## Tests and packaging

```bash
node tests/test-trim.js
bash ./scripts/build.sh
```

The release workflow checks the Firefox and Chromium JavaScript (including the virtual-history renderer), runs the transformation tests, creates both ZIPs, and creates a GitHub Release when a commit message begins with `Release ` and that manifest version has not already been released.

## Limitations

- ChatGPT's internal response schema and DOM are private and can change.
- Alternate conversation branches outside `current_node` ancestry are omitted.
- All-visible-history intentionally removes intermediate tool/system/hidden nodes; a future ChatGPT feature may depend on one.
- **Auto windowed history is experimental** and depends on locating ChatGPT's native conversation-turn container. If ChatGPT changes that DOM structure, native recent turns should still work but virtual older-history insertion may need adapting.
- Virtual older messages are a lightweight reader and do not reproduce every historical ChatGPT widget or rich rendering feature.
- The filter fails open on parsing/schema errors: the original response is left usable.
- Chrome interception is inherently more fragile than Firefox because Chrome MV3 does not expose an equivalent normal-extension response-body stream filter.

## License

GPL-2.0, matching this repository's license.
