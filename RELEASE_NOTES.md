# GPT AntiCurse v0.5.16

Chromium 148+ compatibility and response-shape diagnostics.

## Chrome 148+ browser namespace compatibility

- Chrome 148+ exposes the WebExtensions `browser` namespace in addition to `chrome`, so `typeof browser !== "undefined"` can no longer be used to identify Firefox.
- History routing and popup/debug browser detection now use the packaged manifest's Firefox-specific `browser_specific_settings.gecko` marker instead.
- Restores Chromium's fast transient MAIN-to-ISOLATED history path on modern Chrome instead of incorrectly taking the Firefox background-history path.
- Restores Chrome host-access detection in the popup on modern Chrome.
- Debug reports now identify modern Chrome as `chromium` rather than `firefox`.

## Recovered diagnostics

- A later valid Chromium conversation graph now clears stale `unsupported-conversation-shape`, transform, or JSON-parse diagnostics.
- Recovery clearing is code-specific, so a successful trim cannot accidentally erase an unrelated archive/storage issue.
- A valid `below-limit` response counts as recovery even when no nodes need trimming.

## Response-shape diagnostics

- Unsupported successful conversation responses now record content-free structural metadata: HTTP status/content type, top-level keys, mapping type/count, and current-node presence.
- Non-success HTTP responses are passed through as `http-status` rather than being mislabeled as a ChatGPT schema incompatibility.
- Unsupported response objects are not published as transient conversation archives.

## Regression coverage

- Adds permanent checks preventing `browser` namespace presence from being reused as Firefox detection.
- Existing Chromium Recent/Auto, hydration, native-fidelity, Firefox interception/paging, Firefox fidelity, lifecycle, silent-catch, archive and virtualization tests remain release gates.

## Privacy

- Shape diagnostics contain structural metadata only, never conversation message text.
- No telemetry and no remote extension code.
