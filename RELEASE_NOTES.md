# GPT AntiCurse 0.7.7

This release fixes Auto-Continue model detection on the current ChatGPT composer UI.

## Auto-Continue model detection

- Supports ChatGPT's current composer pill markup, which no longer exposes the old `data-animated-slider-trigger` attribute.
- Correctly recognizes current non-Pro reasoning presets such as **Extra High** instead of falling back to `AC · model ?`.
- Retains the legacy selector as a compatibility fallback.
- Keeps the hard Pro safety gate fail-closed: explicit Pro evidence always disables automatic Stop/continue, and genuinely unknown models remain blocked.

## Regression coverage

- Recovery E2E fixtures now use the current composer markup rather than the retired selector.
- Adds a no-message-slug **Extra High** case that must Auto-Continue successfully.
- Adds a no-message-slug **Pro** case that must never be automatically stopped or continued.
