# GPT AntiCurse v0.7.0

Performance and reliability release for ChatGPT's cursor-paginated long conversations and occasional stalled runs.

## Native pagination firewall

- Keeps ChatGPT's newest conversation page bounded even when the backend advertises older cursor pages.
- The original cursor stays private to AntiCurse while ChatGPT page code receives a terminated `cursor: null`, preventing raw older mapping pages from accumulating in React state.
- If ChatGPT nevertheless requests a cursor page through the normal page path, AntiCurse blocks that older graph from entering page state. Unknown response shapes fail open unchanged.
- **Load previous** and Auto window recover older visible history through AntiCurse's isolated history path using authenticated cursor requests, not by mounting the raw graph back into ChatGPT.
- Firefox reuses the same per-page one-shot bypass mechanism introduced for v0.6.9 Export, including response confirmation and stripping the private marker before the request reaches ChatGPT.
- Export still independently walks every cursor page and remains authoritative when the authenticated fetch succeeds; failures remain explicitly partial.

## Conservative stalled-run recovery

- Adds an **Auto-recover stalled runs** toggle, enabled by default.
- Recovery is event-driven: it watches only the active streaming turn plus direct turn-list structural changes in steady state; broad DOM observation is temporary during discovery/recovery waits.
- Default thresholds are about 2 minutes without meaningful progress, or 5 minutes while a tool is visibly active, followed by a 10-second grace period.
- Before intervention AntiCurse requires a visible current tab, an active streaming turn, the real Stop button, an empty composer with no attachment, and an exact `IS_STREAMING` result from ChatGPT's `stream_status` endpoint twice.
- Recovery clicks the current Stop button, waits for the stopped state, inserts a fixed `.` into the empty ProseMirror using normal input events, clicks the current submit button, and verifies streaming resumes.
- At most one recovery attempt is made per turn. Drafts and attachments are never overwritten. Unknown/API failures do nothing.
- If Stop succeeds but the composer remains wedged, AntiCurse can reload once using a short-lived session marker and only sends the `.` after the composer is empty and usable with no active run.

## Profile-backed UI optimization

- Firefox A/B profiles showed the intervention case had substantially higher event delay, style/display-list/refresh work, minor GC and long-task rates, while identifiable extension JS leaf functions were small.
- No React, MessageChannel, scheduler, or other page-runtime monkey patches were added.
- The one clear cosmetic paint target, ChatGPT's non-composited `loading-shimmer-tertiary` background-position animation, is disabled only while AntiCurse's performance guard is enabled.
- Transform-based working-dot/spin animations remain untouched.

## Browser lifecycle cleanup

- History shell watching switches from temporary broad discovery to direct-child structural observers once the thread is found.
- Auto-window wheel handling is passive and attached only in Auto window mode.
- Initial-position interaction listeners and disabled status-badge observers are detached when no longer needed.
- Firefox keeps the owned `StreamFilter` `copyChunk` path because real Firefox E2E demonstrated that retaining raw event buffers can corrupt deferred output.

## Regression coverage

- Added pure pagination-firewall unit coverage, including fail-open unknown shapes.
- Chromium pagination E2E now models ChatGPT immediately following any leaked cursor and fails if a raw older page reaches page state.
- Firefox extension E2E uses a real paginated conversation and likewise requires the page-facing cursor to be terminated.
- Added real Chromium and Firefox watchdog E2E coverage for Stop → `.` → Send recovery, draft protection, backend fail-open, activity resets, longer active-tool timeout, and one-time reload/resume; Chromium also covers the disabled setting path.
- Existing manifest, syntax, browser-parity, dynamic-code, unit/code-quality, build, Chromium extension/hydration/fidelity, Firefox extension/fidelity, export, and Android gates remain required for release.
