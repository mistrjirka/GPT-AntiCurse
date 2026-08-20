"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

const chromeBackground = source("chrome/background.js");
const chromeBackgroundEntry = source("chrome/background-entry.js");
const firefoxBackground = source("firefox/background.js");
const trimCore = source("chrome/trim.js");
const trimLogical = source("chrome/trim-logical.js");
const trimPipeline = source("chrome/trim-pipeline.js");
const archiveCore = source("chrome/archive.js");
const archiveExport = source("chrome/archive-export.js");
const archiveCapture = source("chrome/archive-capture.js");
const domReady = source("chrome/dom-ready.js");
const diagnostics = source("chrome/diagnostics.js");
const debugState = source("chrome/debug-state.js");
const windowed = source("chrome/windowed.js");
const historyVirtualized = source("chrome/history-virtualized.js");
const chromeContent = source("chrome/content.js");
const firefoxContent = source("firefox/content.js");
const chromeMain = source("chrome/main.js");
const chromePopupController = source("chrome/popup.js");
const popup = source("chrome/popup.html");
const backupPopup = source("chrome/backup-popup.js");
const chromeManifest = JSON.parse(source("chrome/manifest.json"));
const firefoxManifest = JSON.parse(source("firefox/manifest.json"));

assert(chromeBackground.includes("function serializeCounterOperation"), "Chromium counter increments and resets must share one serialized mutation path");
assert(chromeBackground.includes("return serializeCounterOperation(async () =>"), "Chromium reset/update operations must be queued rather than writing around one another");
assert(chromeBackground.includes("updateQueue = queued.catch"), "a failed Chromium counter operation must not poison later mutations");

assert(chromeBackgroundEntry.includes('message.type !== "cg-background-health"'), "Chromium worker must expose a minimal boot-health receiver");
assert(chromeBackgroundEntry.indexOf("cg-background-health") < chromeBackgroundEntry.indexOf("importScripts"), "Chromium boot-health receiver must register before imported worker modules");
assert(chromeBackgroundEntry.includes('phase: "import-failed"'), "Chromium worker startup import failures must be observable");

assert(trimCore.includes("global.CGTrimCore = api"), "raw graph trimming must publish an explicit immutable core module");
assert(!trimCore.includes("global.CGTrim ="), "raw graph trimming must not claim the final production API");
assert(trimLogical.includes("global.CGTrimLogical = api"), "logical budgeting must publish its own named policy module");
assert(!trimLogical.includes("trim.trimConversation ="), "logical budgeting must not monkey-patch the core trimmer");
assert(trimPipeline.includes("global.CGTrim = api"), "one explicit pipeline must compose the production trimmer");
assert(trimPipeline.includes("trimConversation: logical.trimConversation"), "production trimming must select the logical policy explicitly");

assert(archiveExport.includes("global.CGArchiveExport = api"), "archive export must publish its own named module");
assert(!archiveExport.includes("A.archiveToMarkdown ="), "archive export must not monkey-patch the core archive module");
assert(!archiveCore.includes("archiveToMarkdown"), "archive core must not retain a second Markdown exporter");
assert(archiveCapture.includes("buildExportCapture"), "conversation export must be built on explicit demand");
assert(archiveCapture.includes('message.type === "cg-build-export-archive"'), "content script must expose the explicit on-demand export action");
assert(archiveCapture.includes("EXPORT_CAPTURE_TAIL_TURNS = 96"), "explicit export must merge a bounded rendered tail");
assert(!archiveCapture.includes("MutationObserver"), "continuous backup observers must be removed");
assert(!archiveCapture.includes("setTimeout("), "conversation export must not schedule background capture work");
assert(!archiveCapture.includes("pagehide"), "pagehide must not capture conversation text");
assert(!archiveCapture.includes("indexedDB"), "on-demand export capture must remain memory-only");
assert(archiveCapture.includes("debug()"), "transient archive bridge must expose a content-free health snapshot");
assert(!chromeBackground.includes("CGArchiveStore"), "Chromium service worker must never persist conversation text");
assert(!chromeBackgroundEntry.includes("archive-store.js"), "Chromium worker must not load the removed archive store");
assert(!chromeBackgroundEntry.includes("archive-background.js"), "Chromium worker must not load the removed persistence plumbing");
assert(!chromeManifest.permissions.includes("unlimitedStorage"), "Chromium no longer needs unlimitedStorage without persistent backups");
assert(!firefoxManifest.permissions.includes("unlimitedStorage"), "Firefox no longer needs unlimitedStorage without persistent backups");

assert(domReady.includes('"dom-ready", "callback-failed"'), "hydration callback failures must become diagnostics");
assert(domReady.includes("readyPromise.then(() => callback()).catch"), "hydration callback rejection must be observed");

assert(firefoxBackground.includes("const settingsReady = browser.storage.local.get"), "Firefox MV3 interception must gate on authoritative stored settings");
assert(firefoxBackground.includes("await settingsReady"), "Firefox response transformation must wait for settings initialization");
assert(!firefoxBackground.includes("if (!settings.enabled || details.method"), "Firefox must create its StreamFilter before async settings are available");
assert(firefoxBackground.includes("browser.storage.session"), "Firefox event-page state needs a session-store fallback");
assert(firefoxBackground.includes("sessionWriteQueues"), "Firefox session fallback writes must be serialized per key");
assert(firefoxBackground.includes("Early history delivery skipped; caching session fallback"), "large Firefox history should enter storage.session only when direct content-script delivery misses");
assert(firefoxBackground.includes("history-cache-write-failed"), "Firefox session-cache failures must be visible diagnostics");
assert(firefoxBackground.includes("settings-unavailable"), "Firefox settings-read failure must fail open explicitly");
assert(firefoxBackground.includes('message.type === "cg-background-health"'), "Firefox event page must expose background health without changing routing");
assert(firefoxBackground.includes("function serializeCounterOperation"), "Firefox counter increments and resets must share one mutation queue");
assert(firefoxBackground.includes("return settingsReady.then(resetTotals)"), "Firefox reset must run through the serialized counter reset function");
assert(firefoxBackground.includes("requestStartedAt > startedAt"), "Firefox stats/history must reject older overlapping requests");
assert(firefoxBackground.includes("conversationId: conversationId || conversationIdFromEndpoint"), "Firefox stats must carry explicit conversation ownership");
assert(firefoxBackground.includes("statsMatchConversation"), "Firefox cached stats reads must validate the requested conversation");
const firefoxPublishStats = firefoxBackground.slice(firefoxBackground.indexOf("function publishStats"), firefoxBackground.indexOf("function publishConversationScope"));
assert(firefoxPublishStats.indexOf("updateTotals(stats)") < firefoxPublishStats.indexOf("requestStartedAt > startedAt"), "Firefox cumulative totals must count completed trims before stale UI status is rejected");

assert(diagnostics.includes("cgIssueHistory"), "diagnostics must keep bounded local history, not only one last issue");
assert(diagnostics.includes("MAX_HISTORY = 24"), "diagnostic history must be bounded");
assert(diagnostics.includes("function serializeWrite"), "diagnostic record/clear mutations must share one serialized write path");
assert(diagnostics.includes("writeQueue = pending.catch"), "a failed diagnostic mutation must not poison later writes");
assert(diagnostics.includes("return serializeWrite(async () =>"), "diagnostic clear must be ordered with pending diagnostic writes");

assert(debugState.includes('type !== "cg-get-debug-state"'), "content script must expose on-demand health snapshots");
assert(debugState.includes("backendHistory"), "debug snapshot must actively probe the history backend");
assert(debugState.includes("historyController"), "debug snapshot must include history controller/backoff health");
assert(!debugState.includes("message.text"), "debug state must not include archived conversation text");
assert(popup.includes('id="exportDebug"'), "popup must expose debug report download");
assert(popup.includes('id="primaryMetric"'), "popup primary metric must not be named as if it always contains a percentage");
assert(popup.includes("Final answers only") && popup.includes("Readable conversation") && popup.includes("Full technical log"), "export detail choices should use user-facing names");
assert(popup.includes("<summary>Technical details</summary>"), "engineering counters should stay behind a technical-details disclosure");
assert(chromePopupController.includes('primaryMetric.textContent = formatBytes(removedBytes)'), "measured payload reduction should be the primary popup metric");
assert(backupPopup.includes("cgIssueHistory"), "debug report must include recent diagnostic history");
assert(backupPopup.includes("Debug report downloaded"), "debug report flow must give visible confirmation");
assert(backupPopup.includes("packageTarget"), "debug report must distinguish package target");
assert(backupPopup.includes("runtimeBrowser"), "debug report must distinguish actual runtime browser separately");
assert(backupPopup.includes("backgroundKind"), "debug report must expose manifest background architecture");
assert(backupPopup.includes("backgroundHealth"), "debug report must actively probe background health");
assert(backupPopup.includes('type: "cg-build-export-archive"'), "popup export must request an in-memory snapshot from the active tab");
assert(backupPopup.includes("CGArchiveExport.archiveToMarkdown"), "popup must render the in-memory snapshot directly to Markdown");
assert(!backupPopup.includes("cg-export-archive"), "popup must not use persistent archive export plumbing");

assert(windowed.includes("extensionManifest.browser_specific_settings"), "history routing must keep using packaged manifest identity");
assert(windowed.includes("PACKAGE_TARGET"), "history debug must report package identity");
assert(windowed.includes("RUNTIME_BROWSER"), "history debug must report actual runtime browser separately");
assert(!windowed.includes("getBrowserInfo"), "content-script routing must not depend on privileged Firefox runtime APIs");
assert(!backupPopup.includes("getBrowserInfo"), "popup diagnostics must not depend on getBrowserInfo availability");
assert(!windowed.includes('const IS_FIREFOX = typeof browser !== "undefined";'), "Chrome browser alias must not force the Firefox history path");

assert(windowed.includes("const settingsChanged = !!(changes.enabled || changes.mode || changes.maxDisplayMessages)"), "history must filter storage changes to actual history settings");
assert(windowed.includes("if (!settingsChanged) return;"), "diagnostic/counter/archive storage writes must not retrigger history requests");
assert(windowed.includes("let historyRequest = null"), "history controller must keep an explicit single in-flight request slot");
assert(windowed.includes("historyRequest && scope.isCurrent(historyRequest.token)"), "history request reuse must be single-flight only inside the current conversation scope");
assert(windowed.includes("HISTORY_RETRY_MAX_MS = 30000"), "history receiver failures need bounded exponential backoff");
assert(windowed.includes("historyRetryAt"), "history retries must honor a cooldown after failures");

assert(chromeContent.includes("CGConversationScope.create()"), "Chromium status state must be conversation-scoped");
assert(chromeContent.includes("statsBelongToCurrentConversation"), "Chromium must reject stale stats before rendering or watchdog delivery");
assert(chromeContent.includes("issueBelongsToCurrentConversation"), "Chromium must reject stale conversation-specific diagnostics");
assert(chromeContent.includes("conversationId: lastStats && lastStats.conversationId"), "status events must preserve conversation ownership");
assert(chromeContent.includes("STATUS_BADGE_SELECTOR"), "status DOM must have an explicit singleton selector");
assert(chromeContent.includes("badgeObserver.observe(document.body, { childList: true })"), "status deduplication observer must be limited to direct body children");
assert(!chromeContent.includes("innerHTML"), "dynamic status DOM should use node creation/textContent instead of innerHTML");
assert(firefoxContent.includes("CGConversationScope.create()"), "Firefox status state must be conversation-scoped");
assert(firefoxContent.includes("statsBelongToCurrentConversation"), "Firefox content must reject stale pushed/cached stats");

assert(historyVirtualized.includes("HISTORY_HOST_SELECTOR"), "history overlay root must enforce a DOM singleton");
assert(historyVirtualized.includes("function createHistoryHost()"), "history overlay shell should be built with explicit DOM nodes");
assert(!historyVirtualized.includes("host.innerHTML"), "history overlay shell should not be assembled through innerHTML");

assert(chromeContent.includes("RECOVERABLE_MAIN_CODES"), "valid later graphs must clear stale Chromium graph diagnostics");
assert(chromeContent.includes('stats.reason === "below-limit"'), "below-limit valid graphs must count as recovery");
assert(chromePopupController.includes('stats.reason === "below-limit"'), "popup must distinguish legitimate below-limit passthrough from failed optimization");
assert(chromePopupController.includes('setStatus("Bypassed", "error")'), "non-below-limit passthrough must be visible instead of reported as no trimming needed");
assert(chromeContent.includes('DIAGNOSTICS.clear("chromium-main", lastIssue.code)'), "recovery must clear only the matching Chromium issue, not unrelated diagnostics");

assert(chromeMain.includes("function shapeSummary"), "unsupported Chromium responses need structural shape metadata");
assert(chromeMain.includes("shapeTopLevelKeys"), "unsupported-shape diagnostics must include top-level keys without message contents");
assert(chromeMain.includes("responseStatus"), "Chromium diagnostics must include HTTP status");
assert(chromeMain.includes('reason: "http-status"'), "non-success HTTP responses must pass through instead of masquerading as schema incompatibility");
assert(chromeMain.includes('archiveSkipped: "unsupported-shape"'), "unsupported response objects must not overwrite the transient archive");
assert(chromeMain.includes("conversationId: conversationIdFromEndpoint(endpointUrl)"), "Chromium response stats must be bound to their endpoint conversation");

assert(chromeManifest.content_scripts[0].js.includes("trim-pipeline.js"), "Chromium MAIN world must package the explicit trim compositor");
assert(firefoxManifest.background.scripts.includes("trim-pipeline.js"), "Firefox background must package the explicit trim compositor");
assert(chromeManifest.content_scripts[1].js.includes("debug-state.js"), "Chromium must package the debug-state content script");
assert(firefoxManifest.content_scripts[0].js.includes("debug-state.js"), "Firefox must package the debug-state content script");
assert.equal(chromeManifest.version, firefoxManifest.version, "Chrome and Firefox packages must use the same version");
assert(/^\d+\.\d+\.\d+$/.test(chromeManifest.version), "package version must be semantic x.y.z");

console.log("lifecycle/failure-recovery checks: PASS");
