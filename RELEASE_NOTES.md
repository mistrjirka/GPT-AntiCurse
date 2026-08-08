# GPT AntiCurse v0.4.1

Crash-safety hotfix for **Auto windowed history**.

## Fixed

- The v0.4.0 auto-history renderer inserted and removed extension elements directly inside ChatGPT's React-managed conversation container. v0.4.1 removes that design completely.
- Older virtual history now renders in a separate extension-owned **Shadow DOM overlay outside ChatGPT's React conversation subtree**.
- Auto windowed mode now preserves the recent internal/tool/hidden nodes around the newest visible window instead of stripping them all. This keeps recent continuation, tool, and resume state coherent while still removing old graph state.
- Older visible history remains bounded: only a limited number of lightweight archived turns are rendered at once, with older/newer batches swapped as the user scrolls.

## Why

The Firefox crash capture showed a clear regression relative to the earlier working guard profile: recursive conversation traversal increased substantially, nesting became deeper, and `sendResumeRequest` became a significant hot path. Directly mutating React-owned children was also an unsafe integration point.

The hotfix therefore isolates all extension-rendered history from React and uses the compatibility-oriented recent graph window for the native ChatGPT state.

## Other v0.4 features retained

- Latest visible only.
- Auto windowed history, now using the isolated reader.
- Recent safe window.
- All visible history.
- Configurable visible-turn window.
- Optional on-page `AntiCurse · N% trimmed` notice.
- Local graph/data savings counters.

## Privacy

No telemetry or conversation data is transmitted. Trimming, virtual history, and counters remain local to the browser.
