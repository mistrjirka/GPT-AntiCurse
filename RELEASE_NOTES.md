# GPT AntiCurse v0.5.13

Chromium site-access and stale-tab recovery.

## Chromium host access

- Distinguishes a withheld `chatgpt.com` host permission from a genuinely broken page/content-script bridge.
- The popup now checks Chrome's runtime host-access state before reporting a page bridge failure.
- **Save & reload** can request the already-declared `https://chatgpt.com/*` permission when Chrome has withheld it, then reload the tab so `document_start` AntiCurse scripts can run.
- If site access is already granted but the tab has no receiver (for example, a tab that predates an extension update), the popup reports **Reload required** and includes Chrome's actual messaging error.
- The old v0.5.12 `archive/popup-page-bridge-failed` diagnostic is migrated to the correct `bridge` scope and cleared after recovery.

## Diagnostics

- Last issue now includes the error message directly rather than showing only a scope/code pair.
- Exact diagnostic clearing prevents a recovered bridge issue from accidentally clearing an unrelated archive/storage problem.

## Regression coverage

- Adds Chromium host-access checks to CI in addition to the existing real Chromium Recent/Auto, hydration, native-fidelity, and Firefox E2E gates.
- Existing dead-code, silent-catch, packaging-reachability, trim, archive, export, and virtualization tests remain release gates.

## Privacy

- No telemetry and no remote extension code.
- Conversation processing, optional archive storage, diagnostics, counters, history rendering, and Markdown export remain local to the browser.
