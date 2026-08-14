# GPT AntiCurse v0.5.14

Chromium bridge recovery plus archive tail-capture reliability.

## Chromium page bridge

- Keeps the v0.5.13 fix for the Chrome-only state where the popup is alive but no ChatGPT content-script receiver exists.
- Distinguishes Chrome withholding `chatgpt.com` site access from a genuinely missing/stale content-script bridge.
- **Save & reload** can request the already-declared ChatGPT host access from the user gesture and reload the tab so `document_start` scripts are installed.
- If access already exists but the current tab predates an extension install/update, the popup reports **Reload required** and includes Chrome's actual messaging error instead of the old generic `archive/popup-page-bridge-failed` state.
- The startup defaults writer remains removed, preventing a stale asynchronous default write from overwriting a newly selected Recent-N limit.

## Archive tail capture

- Fixes `archive/tail-merge-failed — CGArchive is not defined` seen in Firefox.
- The hydrated DOM tail updater no longer depends on a free cross-script `CGArchive` global merely to identify the current conversation.
- Conversation IDs are derived locally from the current `/c/<id>` page URL; the authoritative network archive and IndexedDB merge path are unchanged.
- Chromium and Firefox use the same tail-capture implementation and a regression test now rejects reintroducing that global dependency.

## Regression coverage

- Existing real Chromium Recent/Auto, host-access, hydration and native-fidelity tests remain release gates.
- Existing real Firefox interception/paging and native-fidelity tests remain release gates.
- Dead packaged code, silent catches, packaging reachability, trim, archive, export, virtualization and cross-browser parity checks remain enabled.

## Privacy

- No telemetry and no remote extension code.
- Conversation processing, optional archive storage, diagnostics, counters, history rendering and Markdown export remain local to the browser.
