# GPT AntiCurse

GPT AntiCurse makes very long ChatGPT conversations responsive by reducing the client-side conversation graph **before ChatGPT's expensive state traversal processes it**.

Firefox Profiler captures of a pathological long chat showed repeated nested JavaScript traversal through ChatGPT conversation-state code. In the original test, reducing roughly 4,500 mapping nodes to a small graph made the tab dramatically faster.

## Installation

Downloads are available from the [GitHub Releases](https://github.com/mistrjirka/GPT-AntiCurse/releases) page. Firefox and Chromium use separate packages.

### Firefox — recommended permanent installation

Normal Firefox Release/Beta requires extensions to be signed by Mozilla. The recommended installation is the signed Firefox Add-ons (AMO) version once the current release is approved and signed.

Mozilla signing overview:
https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/

### Firefox — signed XPI from disk

A Mozilla-signed self-distributed `.xpi` is also permanent:

1. Open `about:addons`.
2. Open the gear menu.
3. Choose **Install Add-on From File…**.
4. Select the signed `.xpi`.

https://extensionworkshop.com/documentation/publish/install-self-distributed/

For self-distribution, Mozilla can sign an unlisted build, for example with `web-ext`:

```bash
web-ext sign --channel=unlisted \
  --api-key="$AMO_JWT_ISSUER" \
  --api-secret="$AMO_JWT_SECRET"
```

### Firefox — temporary development installation

The unsigned Firefox ZIP from GitHub can be tested without signing:

1. Unzip the Firefox package.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on…**.
4. Select the extracted `manifest.json`.

This installation disappears after Firefox restarts.

### Chrome / Chromium

For local use:

1. Unzip the Chrome package.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the package directory.

The unpacked extension remains configured across browser restarts unless removed or disabled. Public distribution should use the Chrome Web Store.

## Using AntiCurse

1. Install the extension and open ChatGPT.
2. Open the AntiCurse popup and make sure **Conversation guarding** is enabled.
3. Choose a mode. **All visible history** is the default and best starting point.
4. Reload the ChatGPT conversation after changing modes or the visible-turn window.
5. The popup shows how much of the conversation graph was removed and how many visible turns remain native.

The floating `AntiCurse · N% trimmed` notice can be disabled independently with **Show on-page status notice**. Disabling it does not disable the guard or popup statistics.

## Modes

### All visible history — default

Keeps every non-hidden user/assistant turn on the active branch while dropping tool/system/explicitly-hidden and off-branch state. The retained history stays in ChatGPT's native UI.

Use this first when you want the whole visible conversation while removing most invisible graph bloat.

### Latest visible only

Keeps only the newest **N visible user/assistant turns**. Tool/system/hidden nodes do not consume the N-turn quota.

This gives the smallest native conversation graph and is useful when maximum responsiveness matters more than scrolling far back. Older turns are unavailable until the mode is changed and the conversation is reloaded.

### Auto windowed history — experimental

Keeps the newest N visible turns in ChatGPT's normal UI **plus the recent interstitial/tool/hidden state around them**. Older internal state is removed.

Older visible user/assistant turns are kept in a lightweight local archive. When you reach the top of the native recent chat and continue scrolling upward, AntiCurse opens an isolated older-history reader. It:

- lives in an extension-owned Shadow DOM overlay rather than ChatGPT's React-owned conversation DOM;
- loads older visible turns in batches;
- keeps only a bounded number of old turns rendered at once;
- unloads distant batches and reloads them as you move through history;
- returns to the native recent chat when you pass the newest archived turn, press Escape, or use the Back button.

Older virtualized history is intentionally lightweight. Plain text is preserved, while old rich widgets, interactive tools, complex attachments, artifacts, or ChatGPT-specific formatting may be simplified. The newest native window remains fully native.

### Recent safe window

Keeps the newest N visible turns **plus all internal nodes between them**. Tool nodes do not consume the N-turn quota.

This is the compatibility-oriented native-only limited mode if a recent ChatGPT feature depends on internal state that **Latest visible only** removes.

## How it works

A ChatGPT conversation contains much more than the messages visible on screen. Long chats can contain thousands of internal nodes: tool calls/results, system state, hidden messages, branches, and bookkeeping. ChatGPT's frontend repeatedly walks this graph, so a huge graph can make ordinary UI work very expensive.

AntiCurse changes the input rather than patching JavaScript loops:

1. ChatGPT requests a conversation from the server.
2. AntiCurse intercepts that response locally in the browser.
3. It follows the active branch and identifies visible user/assistant turns.
4. It removes old or unnecessary graph state according to the selected mode.
5. ChatGPT receives a much smaller graph, so its normal frontend code has much less state to repeatedly traverse.

The server-side conversation is never modified.

## Counters and UI

The popup shows:

- **conversation graph trimmed** — percentage of mapping nodes removed before ChatGPT processes the response;
- **internal nodes removed** — mapping nodes not delivered to ChatGPT's page state;
- **visible turns preserved** — user/assistant turns kept in ChatGPT's native UI;
- **response bytes removed** — payload reduction when measurable, precise on Firefox's stream-filter path;
- cumulative optimized loads, nodes, and bytes since install or reset.

These are measured graph/data reductions, **not an estimated CPU-saved percentage**. Actual CPU improvement depends on the conversation and ChatGPT frontend version.

## Privacy

- No analytics or telemetry.
- No conversation data is sent to the developer or another server.
- Trimming, counters, and virtual-history rendering happen locally.
- Cumulative counters contain numeric totals only.
- Auto windowed history keeps its lightweight visible-message archive only in local browser/tab state.

## Limitations

- ChatGPT's private response schema and DOM can change.
- Alternate branches outside the active `current_node` ancestry are omitted.
- Auto windowed history is experimental and intentionally does not reproduce every historical rich ChatGPT widget.
- The filter fails open on parsing/schema errors so the original response remains usable.
- Chrome interception is inherently more fragile than Firefox's network-level response filtering.

### Auto windowed history stability note

The original v0.4.0 implementation directly inserted and removed extension elements inside ChatGPT's React-managed conversation container and could crash. v0.4.1 moved virtual history into a separate extension-owned Shadow DOM overlay and keeps recent internal state needed by current continuation/tool/resume behavior.

## Browser implementation

### Firefox

Firefox uses `browser.webRequest.filterResponseData()` on the exact `/backend-api/conversation/<id>` response. It parses and reduces the mapping before ChatGPT page JavaScript receives it.

- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/filterResponseData
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/StreamFilter

### Chrome / Chromium

Normal Chrome Manifest V3 extensions do not have Firefox's response-body stream filter. The Chromium build runs a packaged script at `document_start` in the page's `MAIN` world and wraps `Response.prototype.json()` / `Response.prototype.text()` for the exact conversation endpoint. The transformation algorithm is shared with Firefox.

## Development and packaging

```bash
node tests/test-trim.js
bash ./scripts/build.sh
```

Release CI syntax-checks both browser builds and the windowed renderer, runs the transformation tests, builds both ZIPs, and creates a release for commits whose message begins with `Release `.

## License

GPL-2.0.
