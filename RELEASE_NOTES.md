# GPT AntiCurse v0.5.18

Archived-message fidelity fix for long conversations.

## Match current ChatGPT user-message styling

- Fixes autoloaded/archived user messages sometimes using a completely different visual style from native ChatGPT messages.
- Root cause: the fidelity sampler assumed the first child inside a native user message was the text bubble. When the sampled native message had images or files, that first child was actually an attachment row.
- The renderer now finds the real native text node (`whitespace-pre-wrap`) and walks up to the actual user text bubble (`user-message-bubble-color`) instead of depending on child order.
- This works with attachment-first messages and long/collapsible user messages while keeping synthetic archived turns outside ChatGPT's React identity attributes.

## Cleaner archived tool/search activity

- Additional legacy serialized tool payloads are recognized and rendered as compact activity rows instead of raw JSON paragraphs.
- Covers provider-specific web-search payloads, tool discovery, batched commands, file reads, and file searches.
- Raw payloads remain available in the activity-row title for debugging but no longer occupy the visible transcript.

## Regression coverage

- Chromium native-fidelity E2E now deliberately places an attachment row before every native user text bubble. The archived bubble must still inherit the actual native text-bubble and text-node classes.
- The same E2E verifies provider-specific serialized web-search payloads become compact activity rows.
- Existing Chromium Recent/Auto, hydration, Firefox interception/paging, Firefox native-fidelity, lifecycle, retry-loop, archive, and virtualization tests remain release gates.

## Prior package/runtime confusion audit

- No architecture changes in this release are based on treating Chrome debug reports as Firefox reports.
- Browser package identity continues to decide the implementation path; runtime browser identity remains diagnostic metadata only.
- The v0.5.17 retry protection remains valid independently because it prevents any temporary missing background receiver from turning diagnostics storage writes into an unbounded request loop.

## Privacy

- No telemetry or remote extension code.
- Archived conversation processing remains local to the browser.
