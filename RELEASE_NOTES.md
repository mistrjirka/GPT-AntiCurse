# GPT AntiCurse v0.5.5

Markdown export detail controls and plan formatting.

## Markdown export levels

- **Clean** (new default): exports user tasks and only the final visible assistant answer for each task.
- **Progress**: also keeps visible assistant progress/commentary and renders the latest plan for each user task as a Markdown checklist, while omitting raw tool calls.
- **Full**: keeps every non-empty assistant record, including exact tool-call payloads and every plan update.
- Empty assistant records no longer create empty `## Assistant` headings in any mode.

## Plan rendering

- Plan JSON is rendered as a readable checklist (`[x]` completed, unchecked pending/in-progress).
- Progress export consolidates repeated plan snapshots to the latest state for that user task.
- Full export keeps each plan update and includes the exact raw plan payload in a collapsible details block.

## Compatibility

- Existing local conversation archives remain compatible; export classification also recognizes the raw tool-call forms already present in older backups.
- The setting is local to the browser and defaults to Clean.
- Firefox and Chromium use the same formatter and popup controls.

## Privacy

Conversation backup and all three Markdown export modes remain local to the browser. No conversation content is sent to the developer or another service.
