# GPT AntiCurse

GPT AntiCurse speeds up very long ChatGPT conversations by reducing the conversation graph **before ChatGPT's frontend repeatedly processes it**.

Firefox Profiler captures of a pathological long chat showed repeated nested JavaScript traversal through ChatGPT conversation-state code. In the original test, reducing roughly 4,500 mapping nodes to a small graph made the tab dramatically faster.

## Installation

Downloads are available from [GitHub Releases](https://github.com/mistrjirka/GPT-AntiCurse/releases). Firefox and Chromium use separate packages.

### Firefox

Normal Firefox Release/Beta requires Mozilla signing.

**Mozilla Add-ons (AMO):** a listed AMO version installs normally, persists across restarts, and receives browser-managed updates.

**Signed XPI from another source:**

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

If a Chrome Web Store version is available, it can be installed normally from the store. For local/development use:

1. Unzip the Chrome package.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the package directory.

## Using AntiCurse

1. Open the extension popup and enable **Guard enabled**.
2. Select a mode.
3. For limited modes, set the **Visible window** size.
4. Press **Save & reload** after changing the graph mode/window.

The popup keeps the common controls visible and puts detailed counters behind **Details**.

For limited modes, **Load previous N** opens the previous page of visible user/assistant history without restoring old hidden/tool state to ChatGPT's React conversation graph. This is also the manual fallback for Auto windowed history.

The floating on-page `AntiCurse · N% trimmed` status can be disabled independently with **On-page status**.

## Modes

### All visible history — default

Keeps every non-hidden user/assistant turn on the active branch while dropping tool/system/explicitly-hidden and off-branch state. The retained history stays in ChatGPT's native UI.

**Tradeoff:** complete visible native history, but more native graph nodes than the limited modes.

### Latest visible only

Keeps only the newest **N visible user/assistant turns** in ChatGPT's native graph. Tool/system/hidden nodes do not consume the N-turn quota.

Older visible turns remain available through **Load previous N** in the lightweight history reader.

**Tradeoff:** smallest native graph, but old history is shown by AntiCurse rather than ChatGPT's native renderer.

### Auto windowed history — experimental

Keeps the newest N visible turns in ChatGPT's normal UI **plus recent interstitial/tool/hidden state around them**. Older internal state is removed.

AntiCurse keeps a lightweight local archive containing only older visible user/assistant turns. It watches ChatGPT's actual scroll container (`data-scroll-root`, with a fallback detector). When the native recent chat reaches the top, continuing to scroll upward automatically opens the older-history reader.

The reader:

- is a separate extension-owned Shadow DOM overlay, outside ChatGPT's React conversation subtree;
- loads older visible turns in pages of N;
- automatically loads another page near the top;
- includes an explicit **Load previous N** button as a fallback;
- keeps only a bounded number of old turns rendered at once;
- reloads newer archived pages when moving back down;
- returns to the native recent chat when the bottom is passed, Escape is pressed, or **Back to recent** is clicked.

**Tradeoff:** old visible text remains accessible while ChatGPT's own state stays small, but old rich widgets/attachments/artifacts may be represented as simplified text/placeholders.

### Recent safe window

Keeps the newest N visible turns **plus the internal nodes between them**. Tool nodes do not consume the N-turn quota. Older visible turns can still be opened through **Load previous N**.

**Tradeoff:** larger native graph than Latest visible only, but more recent internal state is retained for compatibility.

## How it works

A ChatGPT conversation contains much more than the messages visible on screen. Long chats can contain thousands of internal nodes: tool calls/results, system state, hidden messages, branches, and bookkeeping. ChatGPT's frontend repeatedly walks this graph, so a huge graph can make ordinary UI work expensive.

AntiCurse changes the input rather than patching JavaScript loops:

1. ChatGPT requests a conversation from the server.
2. AntiCurse intercepts that conversation response locally in the browser.
3. It follows the active conversation branch and identifies visible user/assistant turns.
4. It removes old or unnecessary graph state according to the selected mode.
5. ChatGPT receives a much smaller graph, so its normal frontend code has much less state to repeatedly traverse.

The server-side conversation is never modified.

## Counters

The popup reports:

- percentage of mapping nodes removed;
- mapping nodes removed;
- visible turns kept in ChatGPT's native graph;
- response bytes removed when measurable (precise on Firefox's stream-filter path);
- local cumulative optimized loads/nodes/bytes.

These are measured graph/data reductions, **not an estimated CPU-saved percentage**.

## Privacy

- No analytics or telemetry.
- No conversation data is sent to the developer or another server.
- Trimming, counters, and archived-history rendering happen locally.
- Cumulative counters contain numeric totals only.
- Limited modes keep their lightweight visible-message archive only in local browser/tab state.

## Limitations

- ChatGPT's private response schema and DOM can change.
- Alternate branches outside the active `current_node` ancestry are omitted.
- The lightweight old-history reader does not reproduce every historical ChatGPT widget or rich rendering feature.
- Auto windowed history is experimental.
- The response filter fails open on parsing/schema errors so the original response remains usable.
- Chrome interception is inherently more fragile than Firefox's network-level response filtering.

## Browser implementation

### Firefox

Firefox uses `browser.webRequest.filterResponseData()` on the exact `/backend-api/conversation/<id>` response. The JSON is parsed and reduced before ChatGPT page JavaScript receives it.

- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/filterResponseData
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/StreamFilter

### Chrome / Chromium

Normal Chrome Manifest V3 extensions do not expose Firefox's response-body stream filter. The Chromium build therefore runs a packaged script at `document_start` in the page's `MAIN` world and wraps `Response.prototype.json()` / `Response.prototype.text()` only for the exact conversation endpoint.

No remote extension code is loaded.

## Development and source layout

The source is intentionally kept human-readable and unbundled:

- `trim.js` — pure conversation-graph selection/rebuilding logic; browser-independent and unit tested.
- `firefox/background.js` — Firefox response interception, local history archive, and counters.
- `chrome/main.js` — Chromium response-decoding interception.
- `history-overlay.js` — extension-owned paged reader for older visible turns.
- `windowed.js` — ChatGPT scroll-root detection and automatic/manual history opening.
- `content.js` — optional on-page status and Chromium bridge/counters.
- `popup.html`, `popup.css`, `popup.js` — compact extension controls and diagnostics.

There is no minification, bundling, transpilation, `eval`, `new Function`, or remotely loaded JavaScript.

Run the checks/build with:

```bash
node tests/test-trim.js
bash ./scripts/build.sh
```

Release CI additionally:

- validates both manifests;
- syntax-checks every JavaScript file;
- verifies shared Firefox/Chromium modules stay byte-for-byte identical;
- rejects dynamic code execution (`eval` / `Function`);
- runs graph transformation regression tests;
- builds both browser ZIPs.

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
