# GPT AntiCurse

GPT AntiCurse makes very long ChatGPT conversations responsive by reducing the client-side conversation graph **before ChatGPT's expensive state traversal processes it**.

It was built after Firefox Profiler captures of a pathological long chat showed repeated nested JavaScript traversal through ChatGPT conversation-state functions. A prototype that reduced roughly 4,500 mapping nodes to 25 made the affected tab dramatically faster. The current default policy is less destructive: it keeps all actual visible user/assistant history on the active branch and removes tool/system/explicitly-hidden state nodes.

## Downloads

GitHub Releases contain separate packages for:

- `gpt-anticurse-firefox-v*.zip`
- `gpt-anticurse-chrome-v*.zip`

## Modes

### All visible history (default)

- Follow the active `current_node` ancestry.
- Keep every non-hidden `user` / `assistant` display candidate.
- Drop tool, system and explicitly-hidden state nodes.
- Reconnect the kept nodes as a short linear graph.
- Preserve `current_node`.

This aims to retain native scrolling all the way to the first visible message while eliminating most invisible state.

### Recent safe window

Keep the newest N visible user/assistant messages and preserve interstitial state nodes among them. Tool nodes do **not** consume the N-message quota.

## Firefox architecture

Firefox gets the strongest implementation. The extension uses `browser.webRequest.filterResponseData()` on the exact `/backend-api/conversation/<id>` response, parses it, reduces the mapping and writes the smaller JSON stream back before ChatGPT page JavaScript receives it.

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

## Install locally

### Firefox

1. Unzip the Firefox package.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…**.
4. Select `manifest.json` from the extracted `firefox` package.

For ordinary permanent distribution Firefox requires Mozilla signing; the release ZIP is intended for development/testing until an AMO-signed build exists.

### Chrome / Chromium

1. Unzip the Chrome package.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the extracted package directory.

## Diagnostics

The popup and in-page badge show the last transformation, including:

- total mapping nodes before / after
- display candidates before / after
- active-path role counts
- explicitly hidden count
- processing time

## Tests and packaging

```bash
node tests/test-trim.js
./scripts/build.sh
```

The release workflow runs syntax/tests, creates both ZIPs, and creates a GitHub Release when a commit message begins with `Release ` and that manifest version has not already been released.

## Limitations

- ChatGPT's internal response schema is private and can change.
- Alternate conversation branches outside `current_node` ancestry are omitted.
- All-visible-history intentionally removes intermediate tool/system/hidden nodes; a future ChatGPT feature may depend on one.
- The filter fails open on parsing/schema errors: the original response is left usable.
- Chrome interception is inherently more fragile than Firefox because Chrome MV3 does not expose an equivalent normal-extension response-body stream filter.

## License

GPL-2.0, matching this repository's license.
