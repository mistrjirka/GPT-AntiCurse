# GPT AntiCurse v0.7.4

Reliability fixes for Firefox long-conversation history and stalled-run recovery.

## Firefox history reliability

- Reuses complete conversation history already captured from ChatGPT's native Firefox response before making any authenticated history refetch.
- Avoids the redundant native-request + AntiCurse-refetch pattern that could trigger HTTP 429 rate limits when opening or refreshing several long conversations.
- Keeps network history retrieval as a fallback only when captured history is unavailable or incomplete.
- Adds per-conversation rate-limit cooldown for the fallback path: 15 seconds initially, exponentially backing off up to 5 minutes after repeated 429 responses.
- Local captured history can satisfy the request immediately even while a network fallback is cooling down.

## Pro model recovery safety

- Pro model runs (`*-pro`, including GPT-5.6 Pro) are never automatically stopped or auto-continued by AntiCurse.
- Human Stop/Send actions on Pro remain completely native and unrestricted.
- Non-Pro stalled-run recovery behavior is unchanged.

## Verification

- Full unit/code-quality, packaging, Chromium E2E, Firefox E2E, stall-recovery, hydration, and native-fidelity test suites pass.
- Live Firefox smoke testing confirmed working trimmed history with no current issue and no observed 429s across the recorded tabs.
