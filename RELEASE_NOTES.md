# GPT AntiCurse v0.5.6

Markdown export hierarchy and default-detail correction.

## Export formatting

- **Progress is now the default Markdown export level.** Existing explicit Clean/Full choices remain preserved.
- Progress, Plan, Response, and Full-mode tool labels use bold inline labels instead of artificial `###` headings.
- `Final answer` was renamed to the more accurate **Response**, because archived records do not always contain a reliable explicit final-channel marker.
- Original Markdown headings inside assistant responses are preserved at their original hierarchy.
- Empty assistant records continue to be omitted.

## Regression coverage

- Added tests for Progress-as-default behavior.
- Added a hierarchy regression that verifies an original `##` response heading is not nested under an extension-generated heading.
- Added checks that Progress omits raw shell/tool payloads while Full retains them.
- Firefox and Chromium continue to share the same export formatter and defaults.

## Privacy

Conversation backup and all Markdown export modes remain local to the browser. No conversation content is sent to the developer or another service.
