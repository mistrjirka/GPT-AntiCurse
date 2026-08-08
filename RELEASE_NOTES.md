# GPT AntiCurse v0.4.0

Visible-only and virtualized-history release.

## New modes

### Latest visible only

- Keeps only the newest N visible user/assistant turns in ChatGPT's native conversation graph.
- Tool, system, and explicitly-hidden nodes do not consume the N-turn quota.
- Unlike Recent safe window, interstitial hidden/tool state is removed too.

### Auto windowed history (experimental)

- Keeps the newest N visible turns fully native in ChatGPT.
- Extracts a lightweight local archive of older visible user/assistant turns before trimming the response.
- Automatically loads older visible turns in batches as you scroll upward.
- Uses a bounded sliding DOM window: when moving farther into old history, newer injected batches are unloaded; scrolling back down reloads them while unloading distant older batches.
- Never restores tool/system/explicitly-hidden nodes to ChatGPT's React conversation state.
- Older virtualized history is a lightweight reader, so complex widgets, attachments, artifacts, or ChatGPT-specific rich formatting may appear as simplified text/placeholders. The newest native window remains fully native.

## UI

- Adds a **Show on-page status notice** option.
- The floating `AntiCurse · N% trimmed` pill can now be hidden independently without disabling the guard or popup counters.
- The visible-turn count setting now applies to Recent safe window, Latest visible only, and Auto windowed history.

## Tests and packaging

- Adds transformation tests for Latest visible only and Auto windowed history.
- Tests visible-history extraction to ensure tool and explicitly-hidden messages are excluded.
- Release CI now syntax-checks both Firefox and Chrome virtual-history scripts before packaging.

## Privacy

No telemetry or conversation data is transmitted. Auto windowed history keeps its lightweight visible-message archive only locally in browser/tab state. All trimming, virtual rendering, and counters remain local.
