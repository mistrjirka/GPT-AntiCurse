# GPT AntiCurse v0.6.0

Conversation-isolation and extension-packaging release.

## Prevent history from leaking between chats

- Fixes archived history from one ChatGPT conversation being appended to another after SPA navigation.
- Introduces a shared conversation scope token (`{id, generation}`) so asynchronous history work is invalidated when the active `/c/<id>` route changes.
- Late history replies and late network archives from a previous conversation are rejected for the current page.
- DOM backup capture remains bound to the conversation generation where its observer was attached and waits for the current conversation to be confirmed after navigation.
- Rendered archive merges now validate that their source URL belongs to the same conversation.

## Simpler ownership model

- History requests now always carry an explicit conversation ID instead of falling back to mutable tab state.
- Firefox tab/session history caches are conversation-aware and reject mismatched or out-of-order responses.
- Chromium background history no longer infers ownership from `sender.tab.url`.
- Chromium archives use the actual conversation response endpoint as source metadata rather than whichever page URL happens to be current when a slow response finishes.

## Extension icons

- Packages the existing GPT AntiCurse icon at 16, 32, 48, and 128 px.
- Declares the icon in both Chrome and Firefox manifests.
- Adds the toolbar/action icon and the 128×128 store icon.

## Regression coverage

- Adds the critical A → B navigation race: chat A starts loading, the tab navigates to chat B, then A resolves late. B must remain the rendered history.
- Adds manifest/icon packaging checks and conversation-scope tests.
- Removes release-specific fixed-version assertions so package-version tests check browser parity and semantic versioning instead.
- Chromium Recent/Auto, hydration, native-fidelity, Firefox interception/paging/native-fidelity, archive, lifecycle, retry-loop, and virtualization E2E tests remain release gates.

## Privacy

- No telemetry or remote extension code.
- Archived conversation processing remains local to the browser.
