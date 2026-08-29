# GPT AntiCurse 0.7.9

This release fixes internal tool traces and ChatGPT rich-token syntax appearing as plain text when Performance Guard reconstructs older conversation history.

## Older-history rendering

- Tool-targeted assistant records are now excluded by the same shared visibility rule for both graph and paginated conversation formats.
- Fixes raw traces such as `fast|...`, `open|...`, and `length|...` being merged into archived assistant prose.
- Keeps a defensive legacy classifier so already-flattened web-tool traces render as compact activity rather than raw commands.
- Projects ChatGPT rich response tokens before archived Markdown is rendered:
  - `url` tokens remain clickable links;
  - citation/file-citation/memory-citation transport tokens are removed;
  - product/business entities keep their display name;
  - image groups and interactive widgets become concise placeholders instead of raw `...` syntax.

## Architecture

- Moves tool-targeted-message visibility into the shared trim/history core instead of maintaining separate graph and paginated rules.
- The lightweight older-history renderer remains bounded and synthetic; it does not impersonate React-owned ChatGPT turns.

## Regression coverage

- Adds direct contracts for the observed free-form web trace shape and ChatGPT rich-token projection.
- Extends display-candidate tests so a tool-targeted assistant record can never count as a visible conversation turn.
