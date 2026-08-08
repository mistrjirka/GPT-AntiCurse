# GPT AntiCurse

GPT AntiCurse makes very long ChatGPT conversations responsive by reducing the client-side conversation graph **before ChatGPT's expensive state traversal processes it**.

Firefox Profiler captures of a pathological long chat showed repeated nested JavaScript traversal through ChatGPT conversation-state code. In the original test, reducing roughly 4,500 mapping nodes to a small graph made the tab dramatically faster.

## How it works — in normal language

A ChatGPT conversation contains much more than the messages visible on screen. Long chats can contain thousands of internal nodes: tool calls/results, system state, hidden messages, branches, and bookkeeping. ChatGPT's frontend repeatedly walks this graph, so a huge graph can make ordinary UI work very expensive.

AntiCurse changes the input rather than patching JavaScript loops:

1. ChatGPT requests a conversation from the server.
2. AntiCurse intercepts that response locally in the browser.
3. It follows the active branch and identifies visible user/assistant turns.
4. It removes old/unnecessary graph state according to the selected mode.
5. ChatGPT receives a much smaller graph and therefore has much less state to repeatedly traverse.

The server-side conversation is never modified.

## Modes

### All visible history (default)

Keeps every non-hidden user/assistant turn on the active branch while dropping tool/system/explicitly-hidden and off-branch state. The entire retained history uses ChatGPT's native UI.

### Latest visible only

Keeps only the newest **N visible user/assistant turns**. Tool/system/hidden nodes do not consume the N-turn quota. This gives the smallest native conversation graph, but older turns are unavailable until the mode is changed/reloaded.

### Auto windowed history (experimental, v0.4.1 hotfix)

Keeps the newest N visible turns in ChatGPT's normal UI **plus the recent interstitial/tool/hidden state around them**. Keeping that recent internal state is intentional: it avoids breaking current continuation/tool/resume behavior while old state is still removed.

Older visible user/assistant turns are kept in a lightweight local archive. When you reach the top of the native recent chat and continue scrolling upward, AntiCurse opens an isolated older-history reader. The reader:

- is owned entirely by the extension in a separate Shadow DOM overlay;
- is **not inserted into or removed from ChatGPT's React-owned conversation DOM**;
- loads older visible turns in batches;
- keeps only a bounded number of old turns rendered at once;
- unloads distant batches and reloads them as you move through history;
- returns to the native recent chat when you scroll past the newest archived turn, press Escape, or use the Back button.

Older virtualized history is a lightweight reader. Plain text is preserved, while old rich widgets, interactive tools, complex attachments, artifacts, or ChatGPT-specific formatting may be simplified. The newest native window remains fully native.

### Recent safe window

Keeps the newest N visible turns **plus all internal nodes between them**. This is the compatibility-oriented native-only limited mode.

## v0.4.1 crash hotfix

v0.4.0's first Auto windowed implementation directly added/removed extension elements inside ChatGPT's native conversation container. That was unsafe because the container is managed by React. v0.4.1 no longer mutates that subtree at all; virtual history lives in an extension-owned overlay outside it.

The crash profile also showed substantially more recursive conversation-state work and `sendResumeRequest` activity than the earlier working profile. v0.4.1 therefore changed Auto windowed mode from strict visible-only native trimming to the safer recent-state window described above.

## Counters and UI

The popup shows:

- percentage of mapping nodes removed;
- internal mapping nodes removed;
- visible native turns preserved;
- response bytes removed when measurable (precise on Firefox's stream-filter path);
- cumulative optimized loads/nodes/bytes since install or reset.

These are measured graph/data reductions, **not an estimated CPU-saved percentage**.

The floating `AntiCurse · N% trimmed` notice can be independently disabled with **Show on-page status notice**. The guard and popup counters continue working when the notice is hidden.

## Firefox installation

### Normal permanent installation

Normal Firefox Release/Beta requires Mozilla signing. The recommended method is the signed Firefox Add-ons (AMO) listing once the version is approved/signed.

Mozilla signing overview:
https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/

### Signed XPI from disk

A Mozilla-signed self-distributed XPI is also permanent:

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

### Temporary development installation

1. Unzip the Firefox package.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on…**.
4. Select the extracted `manifest.json`.

This disappears after Firefox restart.

## Chrome / Chromium installation

For local testing:

1. Unzip the Chrome package.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the package directory.

Public distribution should use the Chrome Web Store.

## Architecture

### Firefox

Firefox uses `browser.webRequest.filterResponseData()` on the exact `/backend-api/conversation/<id>` response. It parses and reduces the mapping before ChatGPT page JavaScript receives it.

- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/filterResponseData
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/StreamFilter

### Chrome / Chromium

Normal Chrome Manifest V3 extensions do not have Firefox's response-body stream filter. The Chromium build runs a packaged script at `document_start` in the page's `MAIN` world and wraps `Response.prototype.json()` / `Response.prototype.text()` for the exact conversation endpoint. The transformation algorithm is shared with Firefox.

## Privacy

- No analytics or telemetry.
- No conversation data is sent to the developer or another server.
- Trimming, counters, and virtual-history rendering happen locally.
- Cumulative counters contain numeric totals only.
- Auto windowed history keeps its lightweight visible-message archive only in local browser/tab state.

## Tests and packaging

```bash
node tests/test-trim.js
bash ./scripts/build.sh
```

Release CI syntax-checks both browser builds and the windowed renderer, runs the transformation tests, builds both ZIPs, and creates a release for commits whose message begins with `Release `.

## Limitations

- ChatGPT's private response schema and DOM can change.
- Alternate branches outside the active `current_node` ancestry are omitted.
- Auto windowed history is experimental and its older-history reader intentionally does not reproduce every rich ChatGPT widget.
- The filter fails open on parsing/schema errors so the original response remains usable.
- Chrome interception is inherently more fragile than Firefox's network-level response filtering.

## License

GPL-2.0.
