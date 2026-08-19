# GPT AntiCurse v0.6.5

Agent-heavy conversation responsiveness and diagnostics release.

## Agent/tool-heavy conversations

- Fixes a case where long agentic chats could bypass useful trimming because many tool calls, progress records, and hidden technical nodes collapsed into fewer than the configured number of logical conversation units.
- Detects excessive technical graph pressure even when the visible/logical conversation is still below the normal Recent-N limit.
- Compacts older agent state to stable user and final-assistant anchors while preserving the logical conversation history and current node.
- Bounds the fully preserved recent technical tail by both logical units and a raw-node budget, so a few very tool-heavy exchanges cannot keep an unbounded amount of React-visible state.
- Preserves the newest complete exchange when it alone exceeds the technical-node budget rather than slicing live/recent tool state in the middle.

## Mobile and runtime overhead

- Reduces live backup DOM scanning to the newest 8 rendered turns; the wider 96-turn scan remains available for recovery and explicit export/final flush paths.
- Increases live backup-capture throttling from 1.2 s to 2.5 s to reduce repeated work during streaming and mutation-heavy pages.
- Removes a redundant scroll-position read in the windowed-history hot path.

## Diagnostics

- Distinguishes a true below-limit pass-through from loads that were bypassed or not optimized, so startup/hydration or other fail-open paths no longer look like successful "no trimming needed" cases.
- Adds technical-compaction statistics including technical overhead, preserved tail size, node budget, and dropped technical nodes.

## Regression coverage

- Adds synthetic and browser-level coverage for pathological below-window agent graphs and raw-node-tail budgeting.
- Chromium extension, hydration-boundary, native-fidelity, Firefox extension, Firefox native-fidelity, packaging, Android compatibility, and shared-code checks remain release gates.

## Scope

- Normal Recent-N behavior for conversations that genuinely exceed the visible window remains unchanged: recent hidden/tool state is still preserved.
- The more aggressive completed-turn tool-history compaction explored in profiling is not part of this release.
