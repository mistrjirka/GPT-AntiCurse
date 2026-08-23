# GPT AntiCurse 0.7.5

This release focuses on reliable long-run recovery and Firefox history handling on the current ChatGPT UI.

## Automatic stalled-run recovery

- Uses one fixed **120-second inactivity deadline** for non-Pro runs. Active tool UI no longer switches the deadline to five minutes.
- Removes the old extra 10-second post-deadline grace delay while retaining two backend streaming confirmations immediately before an ordinary automatic Stop.
- Keeps recovery working in background/hidden tabs without relying on `requestAnimationFrame`.
- Treats Stop → continuation as a transaction. If ChatGPT takes a long time to cancel a run, AntiCurse stays in `stopping`, waits for the original stream to settle, then inserts and sends the fixed `.` nudge.
- Suspends the countdown while recovery is already in progress and exposes compact `stopping`, `sending`, and `sent…` states.
- Safely aborts if the conversation changes, recovery is disabled, the user starts drafting, or the model becomes Pro/unknown during the transaction.
- Cleans up only AntiCurse's own synthetic `.` if a continuation Send cannot be completed.

## Pro safety and current ChatGPT model UI

- Pro runs remain completely excluded from automatic Stop/continue behavior. Human Stop/Send clicks remain native.
- Model detection now uses the active request's model slug when available, including the immediately preceding user turn used to launch the active assistant turn.
- Localized intelligence-preset labels are resolved through ChatGPT's own preset-to-lane metadata.
- Arbitrary translated status/tool prose containing the word `pro` is no longer treated as sufficient Pro-model evidence.

## Retryable ChatGPT errors

- Automatically reloads the current conversation when the latest assistant turn shows ChatGPT's retryable delivery/network error card.
- Requires the native retryable-error structure and applies per-conversation latching/cooldown to avoid reload loops.

## Firefox history reliability

- Accumulates native paginated conversation history across Firefox response pages instead of dropping history when older-page cursors are present.
- Preserves the existing per-conversation 429 circuit breaker and export bypass behavior.

## UI and diagnostics

- Replaces the large recovery status with a compact neutral `AC` pill.
- Adds request-model/preset-lane and recovery-transaction diagnostics, including the exact last recovery failure stage.

## Validation

The 0.7.5 release candidate was exercised on Firefox 154 against live ChatGPT, including Czech/localized Thinking UI and long-running cancellation behavior. Regression coverage also includes captured live DOM fixtures, hidden-tab recovery, Pro transition races, the fixed 120-second deadline, slow Stop settlement, and retryable network/delivery error handling.
