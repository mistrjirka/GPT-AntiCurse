# GPT AntiCurse v0.6.9

Compatibility release for ChatGPT's new piecewise / virtualized long-conversation loading, restoring complete on-demand exports without forcing old turns back into the page.

## Paginated conversation export

- Adapts Export to ChatGPT's new cursor-paginated conversation endpoint used by very long chats.
- Export follows `cursor` pages and merges their `mapping` objects by node id, retaining the newest page's `current_node` so the existing active-branch exporter can reconstruct the full conversation.
- Pagination runs only when the user explicitly presses Export; normal browsing does not fetch or mount the full conversation.
- Includes a 100-page safety cap plus repeated-cursor detection to prevent accidental infinite paging.
- The current rendered tail is still reconciled in memory so a response that is slightly newer than the API snapshot can be included safely.

## Authentication compatibility

- Export obtains the current ChatGPT access token on demand from `/api/auth/session` and sends it as `Authorization: Bearer ...` on conversation-page requests.
- If that session endpoint does not expose a token, AntiCurse can use the current page's `#client-bootstrap` session token as an in-memory fallback.
- Access tokens are not written to extension storage, Markdown, debug reports, or diagnostics; they exist only in local variables while the explicit export runs.
- If neither authentication source works, Export retains the existing partial fallback and labels the result incomplete rather than silently claiming a full export.

## Firefox / Firefox Android

- Firefox receives a fresh random one-shot AntiCurse bypass token for every conversation cursor page so the extension does not trim its own export requests.
- Each bypass remains scoped to the requesting tab and conversation, is consumed once, and the private marker is stripped before the network request reaches ChatGPT.
- Response confirmation is still required before any Firefox page is treated as authoritative.

## Regression coverage

- Chromium E2E now requires Bearer authentication and a two-page cursor conversation before an export can pass.
- Chromium separately covers `/api/auth/session`, `client-bootstrap` authentication fallback, and an authoritative-fetch failure falling back as explicitly partial.
- Firefox unit coverage verifies independent one-shot bypass grants across consecutive cursor pages.
- A real Firefox process test fetched two authenticated cursor pages, performed two bypass disconnects, reconstructed a complete 560-record export, retained the oldest and newest explicit tool calls, and excluded arbitrary hidden assistant narration.
- Existing Chromium paging, hydration, native-fidelity and Firefox trimming/native-fidelity E2Es remain release gates.
