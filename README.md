# GPT AntiCurse

GPT AntiCurse makes very long ChatGPT conversations responsive by reducing the client-side conversation graph **before ChatGPT's expensive state traversal processes it**.

Firefox Profiler captures of a pathological long chat showed repeated nested JavaScript traversal through ChatGPT conversation-state code. In the original test, reducing roughly 4,500 mapping nodes to a small graph made the tab dramatically faster.

## Installation

Downloads are available from the [GitHub Releases](https://github.com/mistrjirka/GPT-AntiCurse/releases) page. Firefox and Chromium use separate packages.

### Firefox

Normal Firefox Release/Beta requires extensions to be signed by Mozilla.

**Mozilla Add-ons (AMO):** if GPT AntiCurse is available on addons.mozilla.org, installing it there provides a normal persistent installation and browser-managed updates.

**Signed XPI from GitHub or another distribution source:**

1. Open `about:addons`.
2. Open the gear menu.
3. Choose **Install Add-on From File…**.
4. Select the Mozilla-signed `.xpi`.

Mozilla documentation: https://extensionworkshop.com/documentation/publish/install-self-distributed/

**Unsigned development ZIP:**

1. Unzip the Firefox package.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on…**.
4. Select the extracted `manifest.json`.

Temporary installations disappear after Firefox restarts.

### Chrome / Chromium

If a Chrome Web Store version is available, it can be installed normally from the store. For local or development use:

1. Unzip the Chrome package.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the package directory.

The unpacked extension remains configured across browser restarts unless removed or disabled.

## Using AntiCurse

1. Install the extension and open ChatGPT.
2. Open the AntiCurse popup and enable **Conversation guarding**.
3. Select a mode based on the desired balance between compatibility, retained history, and maximum graph reduction.
4. Reload the ChatGPT conversation after changing modes or the visible-turn window.
5. The popup shows how much of the conversation graph was removed and how many visible turns remain native.

The floating `AntiCurse · N% trimmed` notice can be disabled independently with **Show on-page status notice**. Disabling it does not disable the guard or popup statistics.

## Modes

### All visible history — default

Keeps every non-hidden user/assistant turn on the active branch while dropping tool/system/explicitly-hidden and off-branch state. The retained history stays in ChatGPT's native UI.

**Tradeoff:** keeps the complete visible conversation available in the native UI while removing most invisible graph state. It retains more native nodes than the limited-history modes.

### Latest visible only

Keeps only the newest **N visible user/assistant turns**. Tool/system/hidden nodes do not consume the N-turn quota.

**Tradeoff:** produces the smallest native conversation graph, but older turns are unavailable until the mode is changed and the conversation is reloaded.

### Auto windowed history — experimental

Keeps the newest N visible turns in ChatGPT's normal UI **plus the recent interstitial/tool/hidden state around them**. Older internal state is removed.

Older visible user/assistant turns are kept in a lightweight local archive. When the top of the native recent chat is reached and scrolling continues upward, AntiCurse opens an isolated older-history reader. It:

- lives in an extension-owned Shadow DOM overlay rather than ChatGPT's React-owned conversation DOM;
- loads older visible turns in batches;
- keeps only a bounded number of old turns rendered at once;
- unloads distant batches and reloads them as navigation moves through history;
- returns to the native recent chat when the newest archived turn is passed, Escape is pressed, or the Back button is used.

Older virtualized history is intentionally lightweight. Plain text is preserved, while old rich widgets, interactive tools, complex attachments, artifacts, or ChatGPT-specific formatting may be simplified. The newest native window remains fully native.

**Tradeoff:** keeps old visible text accessible without restoring the full ChatGPT graph, but the older-history reader is not a complete reproduction of ChatGPT's native rendering.

### Recent safe window

Keeps the newest N visible turns **plus all internal nodes between them**. Tool nodes do not consume the N-turn quota.

**Tradeoff:** retains more recent internal state for compatibility with ChatGPT features, at the cost of a larger native graph than **Latest visible only**.

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

Run the local tests and build packages with:

```bash
node tests/test-trim.js
bash ./scripts/build.sh
```

Release CI syntax-checks both browser builds and the windowed renderer, runs the transformation tests, builds both ZIPs, and creates a release for commits whose message begins with `Release `.

### Signing a Firefox build for self-distribution

Mozilla can sign an unlisted build for persistent installation. One supported route is `web-ext`:

```bash
web-ext sign --channel=unlisted \
  --api-key="$AMO_JWT_ISSUER" \
  --api-secret="$AMO_JWT_SECRET"
```

Mozilla signing overview: https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/

## License

GPL-2.0.
