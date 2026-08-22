# GPT AntiCurse v0.7.2

Stalled-run recovery hotfix on top of v0.7.1's plural ChatGPT conversation-endpoint compatibility fix.

## Explicit ChatGPT long-wait recovery

- Treats ChatGPT's “Our systems are thinking a bit more about this request…” banner as an authoritative stalled-run signal.
- This is intentionally **OR** logic: the banner can trigger recovery immediately instead of also requiring the ordinary inactivity threshold and `stream_status` confirmation.
- Banner insertion/animation no longer counts as meaningful progress, so showing the warning cannot reset the 2-minute inactivity timer.
- Existing safety rules remain: recovery must be enabled, the tab must be visible, the current Stop button must exist, the composer must be empty with no attachment, and AntiCurse attempts a given turn at most once.
- The normal non-banner recovery path is unchanged and still uses inactivity timing, grace period, and two exact `IS_STREAMING` backend confirmations.

## Regression coverage

- Chromium and Firefox watchdog E2Es include the exact warning text and Help Center link shape observed on ChatGPT.
- The banner fixture deliberately makes `stream_status` return `NOT_STREAMING`; successful Stop → `.` → Send recovery therefore proves the warning is independently sufficient.
- Full v0.7.1 plural-endpoint, export, pagination, packaging, Chromium, Firefox, fidelity, hydration, and stall-recovery coverage remains in place.
