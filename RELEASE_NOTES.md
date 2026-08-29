# GPT AntiCurse 0.7.10

This release extends Auto-Continue to recover responses that finish without producing a user-visible final answer.

## Auto-Continue

- Detects a response that AntiCurse actually observed running, then ends with an idle composer but no substantive final answer.
- Uses incomplete-output evidence such as ChatGPT's `Stopped thinking` state or tool-call activity, so ordinary completed responses are not retried.
- Uses ChatGPT's separate final-output region as an additional completion signal; images, writing blocks, media, links, and other visible final content prevent an unnecessary retry.
- Reuses the same recovery transaction and native `.` insertion/submission path as stalled-response recovery; there is no second continuation implementation.
- Completed-turn model detection waits for hydration when needed and retains the hard rule that Pro runs are never auto-continued.
- Only applies to turns observed running in the current page session, avoiding automatic continuation of old historical turns when opening a conversation.
- Resets the empty-response retry chain after a real answer or a new non-`.` user prompt.
- Caps consecutive empty-response automatic retries at 3 to prevent a broken tool loop from sending `.` indefinitely.
- Adds a clearer `no answer · checking` status while this recovery is starting.

## Diagnostics and tests

- Debug state now reports the terminal-empty candidate, final-output-region detection, and consecutive empty-response recovery count.
- Recovery policy contracts cover the captured `Stopped thinking` + tool activity + empty final-answer shape directly.
