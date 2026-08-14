# GPT AntiCurse v0.5.7

History-mode simplification, Chromium reliability fix, and native-looking inline history.

## Two history modes

- The popup now exposes only **Recent N + button** and **Auto window**.
- Legacy `All visible history` / `Latest visible only` settings migrate to Recent N.
- Recent N keeps the latest bounded window and shows **Load previous N** at the top of the ChatGPT page.
- Auto window loads the previous archived page automatically when the user reaches the top.
- The duplicate popup-level Load previous button was removed.

## Chromium fix

- Chromium no longer relies on a one-shot `window.postMessage` for archived history.
- The MAIN-world bridge retains the latest history payload and answers explicit replay requests from the isolated window controller.
- This fixes the shared failure mode where both Auto window and the inline Load previous button could disappear when the first history message was missed.

## Older-message rendering

- The runtime history reader now supersedes the closed Shadow DOM/plain-text renderer with a light-DOM renderer.
- Older turns now live in extension-owned light DOM immediately before ChatGPT's native `#thread`, so they inherit ChatGPT token colors and typography.
- User turns reuse ChatGPT's bubble surface class; assistant turns reuse the site's `markdown prose` styling.
- A safe local Markdown renderer covers paragraphs, headings, lists, blockquotes, tables, links, inline formatting, and fenced code.
- Consecutive archived assistant records are visually grouped, closer to ChatGPT's current turn presentation.
- React-owned native thread nodes are still never modified.

## Validation

- Added regression checks for exactly two user-facing history modes, Chromium history replay, light-DOM/native-style history rendering, and the on-page Recent N button.
- Firefox and Chromium continue to share the inline history implementation byte-for-byte.
