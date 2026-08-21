# GPT AntiCurse Privacy Policy

Last updated: 21 August 2026

GPT AntiCurse is a browser extension for keeping very long ChatGPT conversations responsive. The extension processes ChatGPT conversation data locally in the browser so it can reduce the amount of old conversation state kept active by the page, provide access to older visible history, and create a local Markdown export only when you request one.

## Data the extension processes

GPT AntiCurse may process the following data while you use it on `https://chatgpt.com/`:

- **Personal communications:** text contained in your ChatGPT conversations, including user and assistant messages.
- **Website content:** ChatGPT conversation responses and visible conversation content needed for trimming, older-history loading, and on-demand export.
- **ChatGPT page URL / conversation identifier:** the extension reads the active ChatGPT URL to determine which conversation is currently open and to keep history and status associated with the correct conversation. GPT AntiCurse does not collect a general history of websites you visit.
- **Extension settings and local diagnostics:** settings, optimization counters, status information, and bounded diagnostic metadata used to operate and troubleshoot the extension.

## How the data is used

The data above is used only for GPT AntiCurse's single purpose: keeping long ChatGPT conversations responsive while preserving access to older visible history and optional local export.

Conversation data may be used locally to:

- reduce old conversation state before ChatGPT page code processes it;
- display older archived turns when requested;
- calculate local optimization statistics such as payload reduction;
- create a Markdown export when you request one; and
- produce local diagnostic information for troubleshooting.

## Local storage

GPT AntiCurse uses browser extension storage for settings, local counters, and bounded diagnostics. Conversation text is not stored there by the current extension.

Downloaded Markdown or debug-report files are ordinary files under your control after download. A browser upgraded from an older AntiCurse release may retain legacy extension-storage data until the browser clears or replaces that extension data; v0.6.9 does not use those legacy conversation backups during normal browsing or export.

## Data transmission and sharing

GPT AntiCurse does **not** operate a server that receives your conversations.

The extension:

- does not send conversation content, browsing activity, or personal communications to the developer;
- does not sell or transfer user data for advertising, profiling, creditworthiness, or unrelated purposes;
- does not include analytics or telemetry;
- does not load or execute remotely hosted extension code; and
- does not provide collected user data to third parties.

Your normal use of ChatGPT still communicates with OpenAI/ChatGPT as it would without the extension. When you explicitly request a Markdown export, GPT AntiCurse may first request the current ChatGPT session information and then make multiple same-origin cursor-page requests to ChatGPT for the currently open conversation. These requests go to ChatGPT, not to the extension developer or any developer-controlled server. The access token used for those requests is kept only in memory for the duration of the export and is not stored or included in exported/diagnostic files.

## Permissions

GPT AntiCurse requests only permissions needed for its functionality:

- **storage** — saves extension settings, counters, and bounded diagnostics.
- **tabs** — identifies the active ChatGPT tab, communicates with the content script, reloads the tab after settings/site-access changes, and can open a fresh ChatGPT tab when you choose **Download & new chat**.
- **host access to `https://chatgpt.com/*`** — allows the extension to operate on ChatGPT conversation pages and responses. GPT AntiCurse does not request host access to unrelated websites.

## On-demand exports

AntiCurse does not continuously back up conversation text. During normal browsing, older-history data is kept transiently for the current page/tab so the lightweight history view can work.

When you explicitly request Markdown export, AntiCurse obtains the current ChatGPT access token in memory (normally from the ChatGPT session endpoint, with the current page bootstrap as a fallback) and follows ChatGPT's cursor-paginated conversation endpoint until the active conversation graph is assembled. It extracts the export-relevant user/assistant history, recognized structured plans, and explicit tool calls in memory, merges the currently rendered tail, generates the file locally, and does not persist the token or conversation snapshot to extension storage. If the authenticated/paginated ChatGPT request fails, AntiCurse may use transient/rendered history as a partial fallback and labels that export as incomplete.

## Debug reports

The extension can generate a local debug report for troubleshooting. Debug reports are designed to contain extension health information and diagnostics rather than conversation text. They are downloaded locally and are not automatically uploaded anywhere.

## Changes to this policy

If GPT AntiCurse changes how it handles user data, this policy will be updated before or together with the relevant extension release.

## Contact

GPT AntiCurse is developed by **mistrjirka (Jiří Svítil)**.

For privacy questions or bug reports, open an issue in the public repository:

https://github.com/mistrjirka/GPT-AntiCurse/issues
