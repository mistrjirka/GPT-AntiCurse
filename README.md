# GPT AntiCurse

GPT AntiCurse is a browser extension for people who keep one ChatGPT conversation running for a long time.

Short chats do not need it. The extension is aimed at coding, research, debugging, agentic work, and other sessions that grow to hundreds or thousands of turns and eventually make the ChatGPT tab noticeably slower.

A long ChatGPT conversation contains more than the text on screen. The conversation response also carries tool calls, hidden records, branches, system state, and other bookkeeping. ChatGPT's frontend has to process that graph. AntiCurse intercepts the conversation locally and gives the page a much smaller recent slice instead of the full historical graph.

The old conversation is not thrown away. AntiCurse keeps a local archive so older messages can still be loaded when needed, and the whole conversation can be exported to Markdown.

That export is also useful when a long-running chat reaches the point where the model can no longer make useful use of all earlier context: export the conversation, open a new chat, attach or paste the useful Markdown, and continue the same project there.

## What it does

- Reduces the amount of old conversation state ChatGPT's frontend has to process.
- Keeps a configurable recent window in ChatGPT's normal UI.
- Lets you load older messages without restoring the old graph to ChatGPT's React state.
- Keeps loaded archive history bounded so repeatedly loading older pages does not build another enormous DOM.
- Stores an optional local backup of the active conversation.
- Exports the backup to Markdown at three detail levels.
- Provides an **Export & new chat** action that downloads the Markdown and opens a fresh ChatGPT tab.
- Does not modify the server-side conversation.
- Does not send conversation data to the developer or to another service.

Firefox and Chromium builds are available. The implementation differs because Firefox exposes a response-body filtering API that Chromium extensions do not.

## History modes

There are only two user-facing modes.

### Recent N + button

ChatGPT receives a bounded recent part of the active conversation. When older archived history exists, AntiCurse places a **Load previous N** control above the normal conversation.

Clicking it inserts another page of older history into the same scrolling flow. Those older turns are extension-owned lightweight DOM; they are not put back into ChatGPT's React conversation graph.

This is the predictable/manual mode and is the default.

### Auto window

Uses the same bounded recent graph, but older history is loaded automatically as you reach the top of the conversation.

There is no separate overlay. Older history appears in the normal page flow above the recent native ChatGPT messages.

## Why the window is not just a raw message count

Agent-heavy conversations often contain several consecutive assistant progress updates around one user request. Counting every one of those fragments independently would make a small window disappear very quickly.

AntiCurse therefore budgets the recent window in logical user/assistant units while still retaining the tool, hidden, and technical graph nodes needed inside the retained recent slice. The performance cutoff changes; recent conversation structure is not flattened into plain text before ChatGPT sees it.

## Older history

Archived history is kept outside ChatGPT's React state. AntiCurse renders only a small moving window of archived pages (normally around three pages at once). Pages farther away are replaced by measured-height spacers and reconstructed when scrolling approaches them.

This matters because simply appending every old message back to the page would eventually recreate another performance problem.

The archived renderer follows the current ChatGPT message shell where possible: thread width, responsive margins, user bubbles, assistant Markdown layout, and activity-row styling are derived from native turns already on the page.

Old tool/activity records cannot always be reproduced exactly as ChatGPT originally displayed them because the local archive does not contain ChatGPT's private React presentation model. Recognizable serialized tool calls are shown as compact activity rows rather than pages of raw JSON. Rich historical widgets, artifacts, attachments, and tool cards may still be simplified.

Synthetic archived turns deliberately do **not** use ChatGPT's native `data-message-author-role` or `data-turn-id` identity attributes, so React and AntiCurse's own live-message collector do not mistake them for native turns.

## Local backup and Markdown export

Conversation backup is optional and stored locally by the extension.

The popup offers three export levels:

- **Clean** — user tasks and the final visible assistant response for each task.
- **Progress** — also keeps visible assistant progress and the latest task plan rendered as a checklist; raw tool calls are omitted. This is the normal/default export format.
- **Full** — keeps all non-empty assistant records, plan updates, and tool calls for cases where exact commands or tool payloads matter.

Empty assistant records are removed from exports.

### Continuing when a chat gets too large

For long technical projects, a useful workflow is:

1. Keep working in one conversation while AntiCurse keeps the tab responsive.
2. When the chat reaches a practical/model context limit, open the AntiCurse popup.
3. Leave Markdown detail on **Progress** unless you specifically need exact tool calls.
4. Click **Export & new chat**.
5. AntiCurse downloads the Markdown and opens a fresh ChatGPT tab.
6. Attach the exported file or paste the relevant parts into the new conversation and continue.

AntiCurse does not automatically upload the exported file into the new chat; it only creates the local export and opens the new tab.

## Installation

Downloads are available from [GitHub Releases](https://github.com/mistrjirka/GPT-AntiCurse/releases). Firefox and Chromium use separate packages.

### Firefox

The normal Firefox release channel requires Mozilla signing. If the extension is installed from Mozilla Add-ons, it behaves like a normal persistent add-on and receives browser-managed updates.

For an unsigned development build:

1. Unzip the Firefox package.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on…**.
4. Select the extracted `manifest.json`.

Temporary installations disappear after Firefox restarts.

### Chrome / Chromium

For a local/development installation:

1. Unzip the Chrome package.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the extracted package directory.

## Basic use

1. Open the AntiCurse popup.
2. Enable **Performance guard**.
3. Choose **Recent N + button** or **Auto window**.
4. Set the window size.
5. Click **Save & reload**.

After the conversation reloads, the popup reports how much graph state was removed. The small on-page status indicator can be disabled independently.

## How it works

A simplified request path is:

1. ChatGPT requests `/backend-api/conversation/<id>`.
2. AntiCurse sees the complete conversation locally in the browser.
3. It archives the visible active branch before trimming when backup is enabled.
4. It follows the active `current_node` ancestry and finds the recent logical window.
5. Older graph state is removed while required recent technical/tool/hidden nodes are retained.
6. ChatGPT's page code receives the smaller graph.
7. Older visible messages remain available through the separate local archive.

The server-side conversation is never rewritten by AntiCurse.

## Firefox implementation

Firefox uses `browser.webRequest.filterResponseData()` on the conversation-document response. The JSON body is parsed and reduced before ChatGPT page JavaScript receives it.

Relevant Mozilla documentation:

- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/filterResponseData
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/StreamFilter

The filter fails open: if parsing or transformation fails, the original response is returned so the conversation remains usable.

## Chromium implementation

Manifest V3 Chromium extensions do not expose Firefox's response-body stream filter. The Chromium build therefore installs packaged code at `document_start` in the page's `MAIN` world and wraps `Response.prototype.json()` / `Response.prototype.text()` only for the exact ChatGPT conversation endpoint.

A settings barrier waits for the extension's storage-backed configuration before the conversation response is transformed. The archive/history bridge is separate from the React-owned recent graph.

No remote extension code is loaded.

## Counters

The popup reports measured reductions such as:

- mapping nodes removed;
- percentage of mapping nodes removed;
- response data removed when measurable;
- transformation time;
- cumulative locally stored optimization counters.

These are graph/data measurements. The displayed percentage is **not** an estimate of CPU time saved.

## Privacy

- No analytics or telemetry service.
- No conversation data is sent to the developer.
- No conversation data is sent to a third-party service by AntiCurse.
- Trimming, archive storage, history rendering, counters, and Markdown export happen locally.
- The server-side ChatGPT conversation is not modified.
- No remote JavaScript is loaded.

## Limitations

- ChatGPT's conversation schema and private DOM can change.
- Only the active `current_node` ancestry is treated as the current conversation branch; abandoned alternate branches are not kept in the trimmed React graph.
- Archived messages are lightweight reconstructions, not React-owned original ChatGPT turns.
- Historical rich widgets, artifacts, citations, attachments, or tool cards may be simplified.
- Exact historical tool-summary wording cannot always be reconstructed from flattened archived records.
- Chromium interception is inherently more dependent on page internals than Firefox's network-level stream filtering.
- A Markdown export is intended as continuation context; AntiCurse cannot force a new model conversation to have the original model's hidden state.

## Source layout

The production extension is intentionally plain, human-readable JavaScript/CSS/HTML with no bundling or minification.

Important files include:

- `trim.js` — browser-independent conversation graph trimming.
- `trim-logical.js` — logical Recent-N budgeting around the core trimmer.
- `archive.js` / `archive-store.js` — local conversation archive handling.
- `archive-export.js` — Clean, Progress, and Full Markdown exports.
- `history-native.js` — lightweight archived message rendering.
- `history-virtualized.js` — bounded archived-history DOM window and spacers.
- `history-fidelity.js` — adapts archived turns to the current native ChatGPT visual shell.
- `windowed.js` — recent/auto history controller and scroll-root handling.
- `firefox/background.js` — Firefox response interception.
- `chrome/main.js` — Chromium conversation-response transformation.
- `chrome/main-settings-barrier.js` — Chromium startup/settings synchronization.

There is no minification, transpilation, bundling, `eval`, `new Function`, or remotely loaded JavaScript in the extension.

Build the production packages with:

```bash
bash ./scripts/build.sh
```

The script directly ZIPs the existing `firefox/` and `chrome/` source directories.

## Testing

Release CI validates both browser packages, checks JavaScript syntax and shared-source parity, rejects dynamic code execution, and runs unit tests for trimming, archives, exports, history virtualization, and history rendering.

It also launches real browser extensions in CI:

- Chromium E2E for response trimming, paging, Auto window, and bounded archive DOM.
- Chromium native-fidelity E2E using a ChatGPT-shaped turn shell.
- Firefox E2E through the real `webRequest.filterResponseData()` path.
- Firefox native-fidelity E2E for archived message width/layout and compact tool activity.

## License

GPL-2.0.
