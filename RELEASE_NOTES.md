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

## Startup reliability

- Firefox now starts synchronously in the real bounded `recent` mode instead of briefly using the removed `visible-history` default while storage initializes.
- Chromium's MAIN-world settings barrier now waits for authoritative storage-backed settings rather than accepting an in-memory fallback from the isolated-world bridge.
- The Chromium fail-safe wait was widened from 300 ms to 2 seconds; normal loads do not incur that delay because the barrier resolves immediately when the document-start bridges publish settings.
- These changes remove install/restart/reload races where a very fast conversation request could use the wrong Recent-N budget or pass through untrimmed history.

## Performance and safety

- The v0.5.8 bounded virtual page window remains unchanged: normally only about three archived pages are mounted.
- Native-fidelity transformation happens while an AntiCurse page is still detached, before it enters the conversation DOM.
- Synthetic archived turns still never use native React identity attributes.
- Firefox and Chromium use byte-identical fidelity JS/CSS.
- CI retains the normal Chromium virtualization test and real Firefox WebExtension test, and adds a Chromium native-fidelity fixture shaped like the current ChatGPT turn shell. It verifies equal native/archive width, inherited live shell classes, compact Development Sandbox activity presentation, placeholder suppression, hidden raw payloads, and zero React identity attributes.
