# GPT AntiCurse v0.5.13

Chromium site-access, startup-settings, and stale-tab recovery.

## Chromium host access

- Distinguishes a withheld `chatgpt.com` host permission from a genuinely broken page/content-script bridge.
- The popup checks Chrome's runtime host-access state before reporting a page bridge failure.
- **Save & reload** requests the already-declared `https://chatgpt.com/*` permission directly from the user click when Chrome has withheld it, then reloads the tab so `document_start` AntiCurse scripts can run.
- If site access is already granted but the tab has no receiver (for example, a tab that predates an extension update), the popup reports **Reload required** and includes Chrome's actual messaging error.
- The old v0.5.12 `archive/popup-page-bridge-failed` diagnostic is migrated to the correct `bridge` scope and cleared after recovery.
- Passive backup-status probing no longer overwrites the main popup's more specific bridge diagnosis.

## Startup settings race

- Removes the eager asynchronous `defaults.js` read-then-write initializer from both browser startup paths.
- That initializer could read an empty/fresh storage snapshot, race a later user/test settings write, and then overwrite a newly selected Recent-N limit with the default value.
- Defaults are now supplied at each read site and legacy/unknown modes are normalized when consumed, so startup never writes default values over newer settings.

## Diagnostics

- Last issue now includes the error message directly rather than showing only a scope/code pair.
- Exact diagnostic clearing prevents a recovered bridge issue from accidentally clearing an unrelated archive/storage problem.

## Regression coverage

- Adds Chromium host-access checks and a permanent assertion that no eager defaults writer can re-enter either browser's background startup.
- Existing real Chromium Recent/Auto, hydration, native-fidelity, Firefox E2E, dead-code, silent-catch, packaging-reachability, trim, archive, export, and virtualization tests remain release gates.

## Privacy

- No telemetry and no remote extension code.
- Conversation processing, optional archive storage, diagnostics, counters, history rendering, and Markdown export remain local to the browser.
