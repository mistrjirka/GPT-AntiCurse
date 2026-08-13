# GPT AntiCurse v0.5.1

Windowed-history reliability and cross-browser correctness update.

## Windowed history

- Auto windowed history now follows ChatGPT's current `data-scroll-from-top` state and automatically reattaches if React replaces the conversation scroll root.
- Fixed-window modes show an in-page **Load previous N** control when the user reaches the top of the native window.
- The default visible window for new installations is now 64 turns instead of 32.

## Chromium

- The MAIN-world response interceptor now waits briefly for the isolated-world settings bridges before consuming a conversation response, avoiding a first-load settings race.
- The backup hook defaults to disabled until its persisted setting has been delivered.

## Conversation backup

- Persistent local IndexedDB backup and Markdown export from v0.5.0 remain unchanged.
- Backups, history paging, and settings remain local to the browser; no conversation content is sent to the developer or another service.
