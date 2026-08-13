# GPT AntiCurse v0.5.0

Persistent local conversation backup and Markdown continuation update.

## Conversation backup

- Saves the active visible user/assistant branch locally in extension IndexedDB before AntiCurse trims it.
- Merges new and streaming turns while the conversation remains open.
- Adds **Export Markdown** and **Export & new chat** actions.
- Marks DOM-only recovery as partial if older unloaded history could not be captured.
- Backup can be disabled independently.

## Privacy

All backup storage, merging, and Markdown export happen locally in the browser. No conversation data is sent to the developer or another service.
