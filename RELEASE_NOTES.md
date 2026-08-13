# GPT AntiCurse v0.5.4

Firefox popup sizing and inline history UX correction.

## Firefox popup

- Fixes the toolbar popup collapsing to almost zero width in Firefox.
- Uses an explicit 360 px body width/min-width without a viewport-relative `100vw` cap, matching Firefox's popup sizing model.

## Older history

- Removes the full-screen AntiCurse history overlay.
- Older archived messages are now rendered inline immediately before ChatGPT's native `#thread`, inside the same conversation scroll flow.
- **Recent safe window** and **Latest visible only** show an inline **Load previous N** button at the top.
- **Auto windowed history** automatically prepends the previous page when the user reaches the top while scrolling upward.
- Prepending preserves the current scroll position so the user can continue naturally upward into the newly loaded page.
- Archived turns use lightweight extension-owned DOM and `content-visibility: auto`; native recent ChatGPT messages are not replaced.

## Validation

- Added regression checks that reject the old fixed full-screen overlay and verify the inline `#thread` anchoring and Firefox-safe popup sizing.
- Firefox and Chromium continue to share the inline history implementation byte-for-byte.

## Privacy

Conversation backup, history paging, graph reduction, and Markdown export remain local to the browser. No conversation content is sent to the developer or another service.
