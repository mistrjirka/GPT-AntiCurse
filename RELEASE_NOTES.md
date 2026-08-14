# GPT AntiCurse v0.5.8

Bounded archived-history DOM, logical Recent-N budgeting, and real Chromium + Firefox WebExtension testing.

## Bounded archived history

- Loaded older history is now virtualized instead of growing the DOM without limit.
- AntiCurse keeps only a small contiguous window of archived pages mounted (normally about three pages / `3×N` logical turns).
- Off-screen loaded pages are measured, removed, and replaced with equal-height spacers.
- Approaching a spacer reconstructs the corresponding page and evicts an opposite off-screen page.
- The complete archive remains available; only presentation DOM is bounded.
- Synthetic archived turns still never use ChatGPT's native `data-message-author-role` / `data-turn-id` identity attributes.

## Logical Recent N

- Consecutive visible assistant progress records now count as one user-facing assistant unit for the Recent-N budget.
- Every user message remains its own unit.
- The existing graph-preserving trimmer still chooses the final cutoff and retains all technical/tool/hidden nodes inside the retained recent slice.
- This prevents long agent progress streams from consuming most of the Recent-N window without flattening or simplifying React-owned recent state.
- Archived paging uses the same logical-unit boundaries so a page never splits one consecutive assistant response group.

## Real Chromium extension E2E

- CI launches the actual unpacked Chromium extension using Playwright's persistent Chromium context.
- A mocked `chatgpt.com` fixture fetches a large tool-heavy conversation through the real MAIN-world response interceptor.
- The test verifies that page/React-side code receives only the bounded graph while AntiCurse retains older history off-React.
- It verifies recent tool/hidden nodes survive the cutoff, Recent N exposes older pages, Auto window loads at the top, synthetic turns do not impersonate native turns, and repeated paging keeps the mounted archive DOM bounded.
- The browser test caught and fixed a duplicate retained-history replay that could reset pages already loaded by the user.

## Real Firefox extension E2E

- CI also launches a real official Firefox build through Selenium/Geckodriver and installs the Firefox package as a temporary WebExtension.
- Firefox loads a local HTTPS fixture under the real `chatgpt.com` hostname, so the production `webRequest.filterResponseData()` transport handles the conversation response.
- The test verifies the logical cutoff before page code sees the graph, preservation of recent tool/hidden nodes, the on-page Recent-N button, archived loading, and absence of native React identity attributes on synthetic history.
- Static/unit tests remain as faster fail-first gates before the real-browser runs.

## Browser parity

- Firefox and Chromium share the logical-window module, virtualized history implementation, and spacer styling byte-for-byte.
- Firefox keeps its `filterResponseData` transport; Chromium keeps the retained/replayed MAIN-world history bridge.
