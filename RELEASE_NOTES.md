# GPT AntiCurse v0.5.3

Popup UX polish and archive-export validation update.

## Popup UI

- The popup now follows the browser light/dark preference instead of forcing a dark theme.
- Increased typography and control sizes, simplified card hierarchy, and added strong keyboard focus indicators.
- Backup state remains explicit in text and now also has distinct Saved / Partial / Off / Not saved styling.
- Primary and secondary actions are visually clearer while keeping the popup compact and dependency-free.

## Conversation backup verification

- Expanded archive regression tests to cover Markdown structure, Unicode and fenced code blocks, hidden-message exclusion, partial-backup warnings, safe filenames, streaming-prefix merges, network refresh with a newer local tail, summaries, and a 300-message export.
- Verified the DOM tail extractor against current ChatGPT virtualized markup: completed user/assistant messages are identified by `data-message-author-role`, while virtualized placeholders and an active tool-progress assistant turn without a final message node are intentionally ignored.
- Full-history backup continues to come from the untouched conversation response before graph trimming; DOM capture is only the incremental rendered tail.

## Privacy

Conversation backup, history paging, graph reduction, and Markdown export remain local to the browser. No conversation content is sent to the developer or another service.
