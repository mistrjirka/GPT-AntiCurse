# GPT AntiCurse v0.6.1

Internal-architecture and reliability cleanup after v0.6.0.

## Explicit module composition

- Replaces order-dependent `CGHistoryOverlay` monkey-patching with named Markdown, virtualizer, fidelity, and hydration modules composed once by `history-overlay.js`.
- Renames the old `history-native.js` helper to the more accurate `history-markdown.js`.
- Makes Markdown export a separate `CGArchiveExport` module instead of mutating `CGArchive` at load time.
- Clarifies archive/export helper names so functions describe their domain responsibility rather than generic operations such as `groups`, `analyze`, or `full`.

## Simpler Chromium interception

- `Response.json()` and `Response.text()` now share one conversation interception pipeline for endpoint validation, HTTP fail-open handling, hydration/settings waiting, archive publication, transformation, diagnostics, and tracing.
- The two native Response wrappers remain explicit and preserve their format-specific parsing/serialization behavior.

## Reliability fixes found during the cleanup

- A rendered DOM backup fingerprint is now committed only after the background confirms persistence. Temporary merge failures can therefore retry unchanged content instead of being incorrectly treated as already saved.
- Diagnostic clears are serialized with diagnostic writes, preventing an older pending write from resurrecting a diagnostic that was already cleared.
- Adds behavioral regression coverage for the diagnostic write/clear ordering race.

## Scope

- No trimming or history-virtualization algorithm was changed.
- The large scroll/history controller remains a single state machine because splitting its tightly coupled UI state into callback-heavy services would add indirection without reducing the underlying complexity.

## Regression coverage

- Chromium Recent/Auto, hydration-boundary, and native-fidelity E2E remain release gates.
- Firefox interception/paging and native-fidelity E2E remain release gates.
- Shared-source parity, syntax, packaging, archive/export, diagnostics, retry-loop, and virtualization tests remain release gates.

## Privacy

- No telemetry or remote extension code.
- Conversation processing and archives remain local to the browser.
