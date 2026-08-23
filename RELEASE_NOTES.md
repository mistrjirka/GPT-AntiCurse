# GPT AntiCurse v0.7.5

Firefox history, rate-limit, and stalled-run recovery fixes validated against the current live ChatGPT DOM.

## Auto-continue reliability

- Keeps automatic recovery disabled for Pro and for unknown model identity; trusted human Stop/Send remains native.
- Recognizes the current localized Pro streaming status and current Thinking/Instant intelligence presets, including `Velmi vysoká` / `Extra High`.
- Recognizes current `.markdown` assistant output and current running-tool markup without treating completed tool icons as still running.
- Treats ChatGPT's explicit long-wait banner as an immediate recovery trigger.
- Auto-continue now works in hidden/background tabs instead of pausing on `document.visibilityState`.
- Removes `requestAnimationFrame` from recovery-critical reattachment and Stop → `.` → Send paths, preventing background-tab suspension from stranding recovery.
- Re-discovers the live streaming turn globally after ChatGPT virtualizes or reparents the thread.
- Failed transient recovery attempts are retryable rather than being permanently marked attempted.
- Re-checks the model during recovery; switching to Pro before the `.` nudge blocks the synthetic Send.

## Firefox history and rate limiting

- Accumulates ChatGPT's native paginated conversation history locally and exposes partial history immediately while older native pages arrive.
- Preserves truthful pagination cursor/page information instead of clearing cached history on an incomplete page.
- Keeps the native rendered DOM bounded while older history is rendered from AntiCurse's local Markdown history view.
- Adds a shared per-tab/per-conversation 429 circuit breaker for singular/plural conversation endpoint families and `/messages` pagination, with exponential cooldown and `Retry-After` support.
- Explicit AntiCurse export/history requests bypass that native-request circuit breaker.

## Verification

- Live Firefox 153 smoke testing covered trimmed long conversations, current native pagination, current Czech/English long-wait UI, Pro exclusion, Thinking/Very High recovery, and background-tab recovery.
- The recovery detector was checked against all 17 distinct supplied ChatGPT HTML/DOM captures; static and real Chromium-DOM fixture passes were 17/17.
- Hidden-tab regression testing covered live-turn reattachment with animation frames disabled, complete Stop → `.` → Send execution, and a Thinking → Pro switch during recovery.
- Full repository unit/code-quality, package, Chromium E2E, Firefox E2E, stall-recovery, hydration, and native-fidelity suites are required green on the release commit.
