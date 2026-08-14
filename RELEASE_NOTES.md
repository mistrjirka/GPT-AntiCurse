# GPT AntiCurse v0.5.9

Native-looking archived history fidelity correction.

## Native thread geometry

- Archived turns now derive their visual shell from the live native ChatGPT user/assistant turns already present in `#thread`.
- AntiCurse copies only class names: it does not clone React nodes, event handlers, IDs, `data-message-author-role`, or `data-turn-id`.
- Thread width, responsive side margins, side-pane behavior, user-bubble width, assistant Markdown layout, and `agent-turn` geometry therefore follow the current ChatGPT UI instead of AntiCurse's old hard-coded approximation.
- A fallback shell uses ChatGPT's current `--thread-content-max-width`, `--thread-content-margin`, and `--user-chat-width` variables when a native template is temporarily unavailable.

## Tool/activity presentation

- Legacy `[Non-text visible message]` placeholders are removed from the visible archived transcript.
- Serialized Development Sandbox calls, shell commands, web searches, plans, and other recognizable internal tool payloads are collapsed into compact tertiary activity rows instead of being rendered as giant Markdown paragraphs.
- The raw serialized payload remains available in the activity row tooltip for debugging.
- Older archives cannot always reproduce ChatGPT's exact generated tool-summary wording because v0.5.8 stored flattened visible text rather than the full private React/tool presentation model; v0.5.9 prioritizes matching the native visual hierarchy without pretending synthetic history is React-owned.

## Performance and safety

- The v0.5.8 bounded virtual page window remains unchanged: normally only about three archived pages are mounted.
- Native-fidelity transformation happens while an AntiCurse page is still detached, before it enters the conversation DOM.
- Synthetic archived turns still never use native React identity attributes.
- Firefox and Chromium use byte-identical fidelity JS/CSS and remain gated by the real-browser E2E suite.
