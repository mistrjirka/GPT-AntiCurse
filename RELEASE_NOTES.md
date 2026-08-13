# GPT AntiCurse v0.5.1

Windowed-history reliability and cross-browser correctness update.

## Windowed history

- Auto windowed history now follows ChatGPT's current `data-scroll-from-top` state and automatically reattaches if React replaces the conversation scroll root.
- Fixed-window modes show an in-page **Load previous N** control when the user reaches the top of the native window.
- The default visible window for new installations is now 64 turns instead of 32.

## Chromium

- The MAIN-world response interceptor now waits briefly for the isolated-world settings bridges before consuming a conversation response, avoiding a first-load settings race.
- Authoritative backup capture happens in the pre-transform response barrier, so it also works when graph trimming is disabled and never needs access to extension APIs from the MAIN world.
- Backup capture defaults to off until the persisted backup setting has arrived.

## Conversation backup

- Persistent local IndexedDB backup and Markdown export from v0.5.0 remain unchanged.
- Backups, history paging, and settings remain local to the browser; no conversation content is sent to the developer or another service.
