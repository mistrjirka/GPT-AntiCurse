# GPT AntiCurse v0.5.2

Pre-AMO consistency update.

## Windowed history

- Auto windowed history uses ChatGPT's current `data-scroll-from-top` state and reattaches if React replaces the conversation scroll root.
- Fixed-window modes provide an in-page **Load previous N** control at the top of the native window.
- The default visible window is consistently 64 turns across popup, graph transformation, Firefox background, Chromium settings bridge, and history-reader fallback paths.

## Chromium correctness

- The MAIN-world response interceptor waits briefly for the isolated-world settings bridges before consuming a conversation response.
- Authoritative backup capture occurs on the untouched response before graph trimming and also works when Guard trimming is disabled.
- Backup capture defaults off until its persisted setting arrives.

## Privacy

Conversation backup, history paging, graph reduction, and Markdown export remain local to the browser. No conversation content is sent to the developer or another service.
