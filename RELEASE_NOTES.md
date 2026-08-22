# GPT AntiCurse v0.7.1

Compatibility hotfix for ChatGPT's current plural conversation-document endpoint.

## Conversation loading

- Recognizes both `/backend-api/conversation/<id>` and `/backend-api/conversations/<id>` for Chromium and Firefox.
- Firefox WebRequest interception, export bypass marker stripping, and bypass confirmation now cover both endpoint families.
- Endpoint parsing is shared between browsers and rejects unrelated plural routes such as `/backend-api/conversations/search`, nested routes, and reserved `init`/`search` segments.
- Query parameters such as `include_has_versions=true&num_turns=10` do not interfere with conversation-ID extraction.

## Export and pagination

- Authoritative Export keeps the proven singular endpoint first and falls back to the plural endpoint only when the singular document route is missing/retired or no longer returns a conversation graph.
- Once an endpoint family succeeds, cursor pagination stays on that same family.
- The plural Export fallback preserves `include_has_versions=true`, `num_turns=10`, cursor walking, Firefox one-shot bypass confirmation, and stripping of AntiCurse's private marker before the request reaches ChatGPT.
- The pagination firewall remains endpoint-agnostic and still suppresses the native cursor while preserving it privately for AntiCurse history.

## Regression coverage

- Chromium and Firefox extension E2Es now use the exact plural initial-request shape observed on ChatGPT while existing singular endpoint fidelity/hydration coverage remains.
- Added direct endpoint-parser regressions, Firefox plural WebRequest/bypass coverage, complete plural Export fallback coverage, and explicit fail-open tests for unrelated plural routes.
- Added an unmocked live-site smoke harness for future compatibility checks; it performs no DNS rewrite or request routing.
- Chromium E2Es now wait for the MV3 storage API before configuration to remove a service-worker startup race in the test harness.
- Full unit/code-quality, shared-code parity, packaging, Chromium extension/hydration/fidelity/stall-recovery, and Firefox extension/fidelity/stall-recovery suites pass for this release.
