# Unreleased

## Defaults and Auto-Continue controls

- Performance Guard is now opt-in on fresh/default-less installs; existing saved choices are preserved.
- Auto-Continue remains enabled independently of Performance Guard.
- Adds a user-settable Auto-Continue stall timeout from 10 to 3600 seconds, with the existing 120-second behavior as the default. Timeout changes reschedule the active watchdog immediately.

# GPT AntiCurse 0.7.12

Follow-up to 0.7.11's reconstructed-history fidelity fixes.

## Archived uploads and files

- Preserves structured ChatGPT file references through graph history, paginated history, authoritative history reloads, and the export/archive boundary.
- Reconstructs lightweight file tiles for older user uploads and file-only turns instead of flattening them to `[Image / attachment]` or dropping them.
- Archived file tiles resolve a fresh ChatGPT file download URL only when clicked; normal history rendering does not download the files.
- Keeps file tiles outside the user text bubble, matching ChatGPT's current attachment layout.
- Assistant responses that already contain a `sandbox:/mnt/data/...` artifact link continue to use 0.7.11's message-scoped interpreter resolver and do not get duplicate generic file cards.

## Auto-Continue history cleanup

- Removes recovery `.` messages only when the raw conversation graph shows the specific pattern `empty assistant -> "." -> assistant`, so ordinary user dots remain visible.
- Empty assistant shells and their recovery nudges no longer consume Performance Guard's display/window budget.
- The same recovery-noise rule is shared by graph trimming, logical-window counting, paginated history, reconstructed history, and authoritative export.

## Regression coverage

- Adds direct contracts for file-only history entries, attachment preservation, recovery-dot detection, and display-budget counting.
- Extends the existing Chromium and Firefox native-fidelity E2Es with an archived user upload and verifies its file tile stays outside the user bubble.
