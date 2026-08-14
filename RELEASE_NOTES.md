# GPT AntiCurse v0.5.10

Chromium history controls startup reliability fix.

## Chrome / Chromium

- Fixes a startup race where the conversation archive could arrive before the isolated history controller had finished reading its stored Recent/Auto settings.
- In that ordering, AntiCurse could successfully trim the conversation but fail to attach either the on-page **Load previous N** control or Auto-window loading.
- Chromium now requests the retained MAIN-world history several times during a short bounded startup settling period instead of cancelling every retry after the first delivery.
- Equivalent history snapshots remain idempotent, so these replays do not reset pages that have already been loaded.

## Clarification

- The **Load previous N** button is shown only when the conversation actually contains older archived turns beyond the active Recent-N window.
- Auto window likewise has nothing to load when the full conversation fits inside the configured recent window.

## Existing behavior retained

- The bounded archived-history virtualizer remains unchanged.
- Native-looking archived message rendering remains unchanged.
- Recent tool/hidden state remains preserved by the graph trimmer.
- Firefox continues to use its network-level `filterResponseData()` path.
- Conversation archives and Markdown exports remain local to the browser.
