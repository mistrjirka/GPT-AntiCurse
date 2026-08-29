# GPT AntiCurse 0.7.11

This release fixes remaining fidelity problems in Performance Guard's reconstructed older-history view.

## Reconstructed history

- Restores generated-file links such as `sandbox:/mnt/data/...` by preserving the originating ChatGPT message ID and resolving downloads through ChatGPT's own interpreter-download API when clicked.
- Shows archived generated files as `preparing…` while resolving and `unavailable` if ChatGPT no longer has the artifact, instead of leaving a dead Markdown-looking link.
- Preserves sandbox links carried through ChatGPT rich `url` tokens as well as ordinary Markdown links, including filenames containing spaces.
- Removes empty synthetic assistant turns instead of turning empty records into fake/non-text messages.
- Introduces one shared visibility policy for graph history, paginated history, and export extraction, preventing those paths from drifting again.
- Excludes private/internal assistant records structurally, including hidden messages, tool-targeted messages, `thoughts` / reasoning-recap content, and analysis-channel records.
- Keeps legitimate visible non-text content such as image/attachment records represented in reconstructed history.
- Consecutive assistant records can still be visually grouped, but each original message ID is retained so artifact links resolve against the correct source message.

## Regression coverage

- Adds direct contracts for private-message filtering, empty-assistant suppression, visible attachments, and sandbox artifact URL construction.
- Adds the new shared modules and tests to release CI cross-browser consistency checks.
