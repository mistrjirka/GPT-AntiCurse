# GPT AntiCurse Privacy Policy

Last updated: 18 August 2026

GPT AntiCurse is a browser extension for keeping very long ChatGPT conversations responsive. The extension processes ChatGPT conversation data locally in the browser so it can reduce the amount of old conversation state kept active by the page, provide access to older visible history, and optionally create a local backup for Markdown export.

## Data the extension processes

GPT AntiCurse may process the following data while you use it on `https://chatgpt.com/`:

- **Personal communications:** text contained in your ChatGPT conversations, including user and assistant messages.
- **Website content:** ChatGPT conversation responses and visible conversation content needed for trimming, older-history loading, backup, and export.
- **ChatGPT page URL / conversation identifier:** the extension reads the active ChatGPT URL to determine which conversation is currently open and to keep history, status, and backups associated with the correct conversation. GPT AntiCurse does not collect a general history of websites you visit.
- **Extension settings and local diagnostics:** settings, optimization counters, status information, and bounded diagnostic metadata used to operate and troubleshoot the extension.

## How the data is used

The data above is used only for GPT AntiCurse's single purpose: keeping long ChatGPT conversations responsive while preserving access to older visible history and optional local export.

Conversation data may be used locally to:

- reduce old conversation state before ChatGPT page code processes it;
- display older archived turns when requested;
- calculate local optimization statistics such as payload reduction;
- maintain an optional persistent local conversation backup;
- create a Markdown export when you request one; and
- produce local diagnostic information for troubleshooting.

## Local storage

GPT AntiCurse uses browser extension storage for settings, local counters, diagnostics, and—when **Persistent backup** is enabled—conversation archives.

Long conversations can exceed ordinary extension storage quotas, so the extension requests `unlimitedStorage` for the optional local backup feature.

Stored extension data remains on your device until it is replaced or removed through browser/extension data clearing or by uninstalling the extension. Downloaded Markdown or debug-report files are ordinary files under your control after download.

## Data transmission and sharing

GPT AntiCurse does **not** operate a server that receives your conversations.

The extension:

- does not send conversation content, browsing activity, or personal communications to the developer;
- does not sell or transfer user data for advertising, profiling, creditworthiness, or unrelated purposes;
- does not include analytics or telemetry;
- does not load or execute remotely hosted extension code; and
- does not provide collected user data to third parties.

Your normal use of ChatGPT still communicates with OpenAI/ChatGPT as it would without the extension. GPT AntiCurse does not add an additional developer-controlled destination for that data.

## Permissions

GPT AntiCurse requests only permissions needed for its functionality:

- **storage** — saves extension settings, counters, diagnostics, and local backup metadata/data.
- **tabs** — identifies the active ChatGPT tab, communicates with the content script, reloads the tab after settings/site-access changes, and can open a fresh ChatGPT tab when you choose **Download & new chat**.
- **unlimitedStorage** — allows optional local backups of very long conversations that may exceed the normal extension storage quota.
- **host access to `https://chatgpt.com/*`** — allows the extension to operate on ChatGPT conversation pages and responses. GPT AntiCurse does not request host access to unrelated websites.

## Persistent backup and exports

Persistent backup is optional. When enabled, conversation content is stored in the extension's local browser storage so older history can remain available and the conversation can be exported after a reload.

Markdown export happens only when you explicitly request it. The generated file is downloaded to your device.

## Debug reports

The extension can generate a local debug report for troubleshooting. Debug reports are designed to contain extension health information and diagnostics rather than conversation text. They are downloaded locally and are not automatically uploaded anywhere.

## Changes to this policy

If GPT AntiCurse changes how it handles user data, this policy will be updated before or together with the relevant extension release.

## Contact

GPT AntiCurse is developed by **mistrjirka (Jiří Svítil)**.

For privacy questions or bug reports, open an issue in the public repository:

https://github.com/mistrjirka/GPT-AntiCurse/issues
