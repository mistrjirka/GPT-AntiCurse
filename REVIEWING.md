# Reviewing GPT AntiCurse

GPT AntiCurse is intentionally distributed as plain, human-readable source. There is no bundling, transpilation, minification, code generation, or remotely loaded JavaScript.

## Runtime flow

### Firefox

1. `firefox/background.js` intercepts only exact conversation documents under `GET https://chatgpt.com/backend-api/conversation/<id>` or `/backend-api/conversations/<id>` using `browser.webRequest.filterResponseData()`.
2. `firefox/trim.js` performs the pure conversation-graph transformation.
3. The reduced JSON is returned to ChatGPT. Parse/schema failures are fail-open and the original response is written back.
4. For limited-history modes, the background script also extracts a local archive containing only visible user/assistant text.
5. `firefox/windowed.js` watches ChatGPT's `data-scroll-root` and decides when older history should open.
6. `firefox/history-overlay.js` renders that archive in an extension-owned Shadow DOM overlay outside ChatGPT's React conversation subtree.
7. `firefox/content.js` renders only the optional small status notice.

### Chrome / Chromium

Chrome Manifest V3 does not expose Firefox's response-body stream filter to normal extensions.

1. `chrome/main.js` is a packaged `document_start` MAIN-world script.
2. It wraps `Response.prototype.json()` and `Response.prototype.text()` only for the exact ChatGPT conversation-document endpoint.
3. The same `trim.js` transformation is applied before the ChatGPT application receives the parsed value/text.
4. Settings/stats/history are passed between MAIN and isolated worlds with same-origin `window.postMessage` messages using a private channel string.
5. `chrome/windowed.js` and `chrome/history-overlay.js` provide the same local older-history reader.
6. `chrome/background.js` only serializes numeric counter updates across tabs.

## Source files

- `*/trim.js` — pure graph selection, visible-message extraction, and mapping reconstruction.
- `firefox/background.js` — Firefox network response filtering and local per-tab archive/state.
- `chrome/main.js` — Chromium response decoding interception.
- `*/windowed.js` — native ChatGPT scroll-root detection and manual/automatic history opening.
- `*/history-overlay.js` — bounded paged reader for older visible turns.
- `*/content.js` — optional status UI; Chromium also bridges settings/stats.
- `*/popup.html`, `*/popup.css`, `*/popup.js` — extension controls and diagnostics.
- `tests/test-trim.js` — browser-independent graph transformation regression tests.

Files marked `*/` are kept byte-for-byte identical between Firefox and Chromium by release CI where applicable.

## Security and privacy properties

- Host access is restricted to `https://chatgpt.com/*`.
- Conversation interception accepts only the exact `/backend-api/conversation/<id>` and `/backend-api/conversations/<id>` document paths.
- No analytics or telemetry.
- No user conversation is sent to the developer or another service.
- No remote extension code.

- No `eval()` or `Function()` dynamic code execution; release CI rejects either pattern.
- Older-history archives live only in browser/tab memory and contain only visible user/assistant text plus IDs/timestamps needed for ordering.
- The extension never modifies the server-side conversation.
- The Firefox response filter fails open if parsing/transformation fails.
- Extension-rendered older history is isolated from ChatGPT's React-owned conversation DOM.

## Validation

Release CI performs:

```text
manifest JSON validation
JavaScript syntax checks for every shipped JS file
byte-for-byte checks for shared Firefox/Chromium modules
rejection of eval()/Function() dynamic execution
graph transformation regression tests
package creation
```

Local graph tests can be run with:

```bash
node tests/test-trim.js
```

Packages are created without source transformation:

```bash
bash ./scripts/build.sh
```

The build script only ZIPs the browser directories; the JavaScript inside the published ZIP is the same source stored in the repository.

## Genuine live-site compatibility smoke

The deterministic browser E2Es intentionally use local fixtures. Before a release that changes ChatGPT interception, also run a real-site smoke with no DNS override and no request routing:

```bash
npm install --no-save --no-package-lock playwright@1.55.0
npx playwright install --with-deps --no-shell chromium
CHATGPT_SMOKE_URL='https://chatgpt.com/c/<conversation-id>' node tests/live-chatgpt-smoke.js
```

For an unauthenticated browser where anonymous chat creation is available, `CHATGPT_SMOKE_CREATE_ANON=1 node tests/live-chatgpt-smoke.js` creates one tiny throwaway chat and reloads it. The smoke fails if the real detail endpoint is not observed, if AntiCurse does not emit matching interception stats, or if the live response shape is rejected. A Cloudflare/bot challenge is a failed/blocked release gate, not a fixture pass.
