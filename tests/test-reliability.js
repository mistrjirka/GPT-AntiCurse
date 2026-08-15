"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

const chromeBackground = source("chrome/background.js");
const chromeBackgroundEntry = source("chrome/background-entry.js");
const firefoxBackground = source("firefox/background.js");
const archiveStore = source("chrome/archive-store.js");
const archiveBackground = source("chrome/archive-background.js");
const archiveCapture = source("chrome/archive-capture.js");
const domReady = source("chrome/dom-ready.js");
const diagnostics = source("chrome/diagnostics.js");
const debugState = source("chrome/debug-state.js");
const windowed = source("chrome/windowed.js");
const chromeContent = source("chrome/content.js");
const chromeMain = source("chrome/main.js");
const popup = source("chrome/popup.html");
const backupPopup = source("chrome/backup-popup.js");
const chromeManifest = JSON.parse(source("chrome/manifest.json"));
const firefoxManifest = JSON.parse(source("firefox/manifest.json"));

assert(chromeBackground.includes("const operation = updateQueue.then"), "Chromium counter updates must expose each operation separately");
assert(chromeBackground.includes("updateQueue = operation.catch"), "a failed Chromium counter write must not poison all later updates");

assert(chromeBackgroundEntry.includes('message.type !== "cg-background-health"'), "Chromium worker must expose a minimal boot-health receiver");
assert(chromeBackgroundEntry.indexOf("cg-background-health") < chromeBackgroundEntry.indexOf("importScripts"), "Chromium boot-health receiver must register before imported worker modules");
assert(chromeBackgroundEntry.includes('phase: "import-failed"'), "Chromium worker startup import failures must be observable");

assert(archiveStore.includes("dbPromise = opening.catch"), "IndexedDB open failures must be recoverable");
assert((archiveStore.match(/dbPromise = null/g) || []).length >= 3, "IndexedDB promise must reset on initial state, failure, and version change");
assert(archiveStore.includes("db.onversionchange"), "IndexedDB connections must close/reset for a version change");

assert(!archiveBackground.includes("activeByTab"), "MV3 archive lookup must not depend on an ephemeral tab->conversation global cache");
assert(archiveBackground.includes("message && message.conversationId"), "archive reads must use an explicit durable conversation id");

assert(!archiveCapture.includes("setTimeout(startObserver"), "archive thread discovery must not poll the DOM forever");
assert(archiveCapture.includes("discoveryObserver"), "archive thread discovery should be mutation-driven");
assert(archiveCapture.includes("if (!archiveEnabled) return;"), "DOM backup observers must stay off when persistent backup is disabled");
assert(!archiveCapture.includes(".innerText"), "tail backup extraction should not use innerText and force layout");
assert(archiveCapture.includes("debug()"), "archive bridge must expose a content-free health snapshot");

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

assert(diagnostics.includes("cgIssueHistory"), "diagnostics must keep bounded local history, not only one last issue");
assert(diagnostics.includes("MAX_HISTORY = 24"), "diagnostic history must be bounded");
assert(diagnostics.includes("writeQueue = operation.catch"), "diagnostic persistence must recover after a failed write");

assert(debugState.includes('type !== "cg-get-debug-state"'), "content script must expose on-demand health snapshots");
assert(debugState.includes("backendHistory"), "debug snapshot must actively probe the history backend");
assert(debugState.includes("historyController"), "debug snapshot must include history controller/backoff health");
assert(!debugState.includes("message.text"), "debug state must not include archived conversation text");
assert(popup.includes('id="exportDebug"'), "popup must expose debug report download");
assert(backupPopup.includes("cgIssueHistory"), "debug report must include recent diagnostic history");
assert(backupPopup.includes("Debug report downloaded"), "debug report flow must give visible confirmation");
assert(backupPopup.includes("packageTarget"), "debug report must distinguish package target");
assert(backupPopup.includes("runtimeBrowser"), "debug report must distinguish actual runtime browser");
assert(backupPopup.includes("backgroundKind"), "debug report must expose manifest background architecture");
assert(backupPopup.includes("backgroundHealth"), "debug report must actively probe background health");

// Package identity controls architecture. Runtime UA is diagnostics only. This
// preserves Firefox behavior while also making Chrome-with-Firefox-package cases explicit.
assert(windowed.includes("extensionManifest.browser_specific_settings"), "history routing must keep using packaged manifest identity");
assert(windowed.includes("PACKAGE_TARGET"), "history debug must report package identity");
assert(windowed.includes("RUNTIME_BROWSER"), "history debug must report actual runtime browser separately");
assert(!windowed.includes("getBrowserInfo"), "content-script routing must not depend on privileged Firefox runtime APIs");
assert(!backupPopup.includes("getBrowserInfo"), "popup diagnostics must not depend on getBrowserInfo availability");
assert(!windowed.includes('const IS_FIREFOX = typeof browser !== "undefined";'), "Chrome browser alias must not force the Firefox history path");

// Failed history request -> diagnostic -> storage.local used to recursively
// retrigger history lookup. Only actual history settings may now trigger it.
assert(windowed.includes("const settingsChanged = !!(changes.enabled || changes.mode || changes.maxDisplayMessages)"), "history must filter storage changes to actual history settings");
assert(windowed.includes("if (!settingsChanged) return;"), "diagnostic/counter/archive storage writes must not retrigger history requests");
assert(windowed.includes("historyRequestPromise"), "history background requests must be single-flight");
assert(windowed.includes("HISTORY_RETRY_MAX_MS = 30000"), "history receiver failures need bounded exponential backoff");
assert(windowed.includes("historyRetryAt"), "history retries must honor a cooldown after failures");

assert(chromeContent.includes("RECOVERABLE_MAIN_CODES"), "valid later graphs must clear stale Chromium graph diagnostics");
assert(chromeContent.includes('stats.reason === "below-limit"'), "below-limit valid graphs must count as recovery");
assert(chromeContent.includes('DIAGNOSTICS.clear("chromium-main", lastIssue.code)'), "recovery must clear only the matching Chromium issue, not unrelated diagnostics");

assert(chromeMain.includes("function shapeSummary"), "unsupported Chromium responses need structural shape metadata");
assert(chromeMain.includes("shapeTopLevelKeys"), "unsupported-shape diagnostics must include top-level keys without message contents");
assert(chromeMain.includes("responseStatus"), "Chromium diagnostics must include HTTP status");
assert(chromeMain.includes('reason: "http-status"'), "non-success HTTP responses must pass through instead of masquerading as schema incompatibility");
assert(chromeMain.includes('archiveSkipped: "unsupported-shape"'), "unsupported response objects must not overwrite the transient archive");

assert(chromeManifest.content_scripts[1].js.includes("debug-state.js"), "Chromium must package the debug-state content script");
assert(firefoxManifest.content_scripts[0].js.includes("debug-state.js"), "Firefox must package the debug-state content script");
assert.equal(chromeManifest.version, "0.5.18");
assert.equal(firefoxManifest.version, "0.5.18");

console.log("lifecycle/failure-recovery checks: PASS");
