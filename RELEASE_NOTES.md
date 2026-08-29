# GPT AntiCurse 0.7.8

This release fixes Auto-Continue getting stuck after it successfully stops a stalled ChatGPT run.

## Auto-Continue reliability

- Uses one shared recovery transaction for ordinary stalls, ChatGPT's long-wait warning, pre-output stalls, shell-loading stalls, and post-reload recovery.
- Stops treating a stale `data-streaming-response-status` marker as proof that a run is still active after the Stop control has disappeared and the composer is usable.
- Uses the stably interactive composer—not stale backend/streaming flags—as the post-Stop readiness signal.
- Treats a failed/unavailable `stream_status` lookup as unknown instead of incorrectly assuming the run has already settled.
- Bounds `stream_status` checks so a hung request cannot hold recovery indefinitely.
- Waits for model information to hydrate after a guarded reload instead of failing immediately on a transient unknown model.
- Keeps the Pro safety rule fail-closed: explicit Pro always blocks automatic Stop/continue.
- Quarantines already settled or attempted turns so they cannot leave a permanent `AC · 0s` countdown.

## Status UI

- Separates **stopping** from **stopped · preparing**, so the pill no longer claims it is still stopping after ChatGPT is already idle.
- Replaces internal shorthand with clearer labels such as **continue in 1:20**, **checking stall**, **continuing**, **starting…**, **off for Pro**, and **waiting for model**.
- Uses one DOM owner for the bottom-right AntiCurse pill instead of two competing renderers.
- Adds descriptive hover text for each Auto-Continue state.

## Test cleanup

- Removes the dedicated synthetic stall-recovery browser E2Es that modeled an invented ChatGPT UI and gave false confidence when production markup/state differed.
- Replaces them with direct recovery-policy contracts for the observed failure shapes: stale streaming state after Stop, idle composer settlement, model-hydration races, Pro exclusion, and zombie-countdown prevention.
- Keeps browser E2Es where a real browser is useful: extension loading/interception, hydration boundaries, pagination, and native-fidelity rendering.
