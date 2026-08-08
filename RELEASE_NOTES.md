# GPT AntiCurse v0.2.0

First public prototype release.

## Firefox

- Uses Firefox `webRequest.filterResponseData()` to reduce the conversation JSON before ChatGPT page JavaScript receives it.
- Default **All visible history** mode keeps non-hidden user/assistant turns while removing the bulk of tool/system/hidden state nodes.
- **Recent safe window** is available as a conservative fallback.
- Popup diagnostics show mapping-node reduction, visible-message counts, roles, hidden nodes and processing time.

## Chrome / Chromium

- Uses the same graph-reduction algorithm.
- Because normal Chrome Manifest V3 extensions do not have Firefox's response-body `filterResponseData()` API and cannot normally use blocking `webRequest`, the Chromium build runs at `document_start` in the page's `MAIN` world and intercepts the native `Response.json()` / `Response.text()` decode boundary for the exact ChatGPT conversation endpoint.
- This is less privileged and may be less robust than the Firefox build if ChatGPT changes its networking implementation.

## Measured motivation

On the supplied Firefox profiles, reducing a long conversation from roughly 4,500 mapping nodes to a tiny active graph reduced the pathological recursive JavaScript traversal from the dominant CPU cost to a small fraction of CPU time. v0.2 then changed the policy to preserve all actual visible user/assistant history while dropping invisible state.

This extension modifies only the response delivered to the local browser. It does not modify the server-side conversation.
