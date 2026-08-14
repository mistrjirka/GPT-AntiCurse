"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
function source(relative) { return fs.readFileSync(path.join(__dirname, "..", relative), "utf8"); }

const markdown = source("firefox/history-native.js");
const virtualized = source("firefox/history-virtualized.js");
const windowed = source("firefox/windowed.js");
const domReady = source("firefox/dom-ready.js");
const historyHydration = source("firefox/history-hydration-safe.js");
const firefoxContent = source("firefox/content.js");
const chromeContent = source("chrome/content.js");
const firefoxArchiveCapture = source("firefox/archive-capture.js");
const chromeArchiveCapture = source("chrome/archive-capture.js");
const chromeBackground = source("chrome/background.js");
const chromeBackgroundEntry = source("chrome/background-entry.js");
const chromeMain = source("chrome/main.js");
const popupHtml = source("firefox/popup.html");
const firefoxPopup = source("firefox/popup.js");
const chromePopup = source("chrome/popup.js");
const contentCss = source("firefox/content.css");
const sizing = source("firefox/popup-sizing.css");
const chromeManifest = JSON.parse(source("chrome/manifest.json"));
const firefoxManifest = JSON.parse(source("firefox/manifest.json"));

assert(markdown.includes("function renderMarkdown"), "history Markdown parser must remain packaged");
assert(!markdown.includes("class NativeHistory"), "superseded non-virtualized renderer must not remain as dead compatibility code");
assert(!markdown.includes("insertBefore(this.host"), "Markdown module must not own history attachment anymore");
assert(virtualized.includes('document.querySelector("#thread")'), "active history must anchor to ChatGPT #thread");
assert(virtualized.includes("insertBefore(this.host, thread)"), "active history must stay immediately before native #thread");
assert(!virtualized.includes("attachShadow"), "active history renderer must use light DOM so ChatGPT styles can apply");
assert(virtualized.includes("markdown prose dark:prose-invert"), "older text should use ChatGPT markdown/prose styling");
assert(virtualized.includes("user-message-bubble-color"), "older user turns should reuse ChatGPT's bubble surface class");
assert(virtualized.includes("renderMarkdown"), "older Markdown should be rendered structurally rather than as pre-wrapped plaintext");
assert(virtualized.includes("function grouped"), "consecutive assistant records should be visually grouped");
assert(virtualized.includes("Load previous ${next}"), "Recent N mode needs an inline Load previous button");
assert(virtualized.includes('this.mode === "recent"'), "the button must belong only to Recent N mode");
assert(contentCss.includes("#cg-window-history-host"), "light-DOM history must have scoped fallback styling");
assert(contentCss.includes("content-visibility: auto"), "archived turns should stay lightweight off-screen");

assert(domReady.includes('window.addEventListener("load"'), "extension DOM must wait for the page load boundary");
assert((domReady.match(/requestAnimationFrame/g) || []).length >= 2, "hydration gate should wait through two animation frames");
assert(domReady.includes("requestIdleCallback"), "hydration gate should wait for an idle slice after load");
assert(historyHydration.includes("pendingHistory"), "history received during hydration must be buffered rather than dropped");
assert(historyHydration.includes("gate.isReady() ? rawEnsureAttached() : false"), "history must not attach inside React's SSR tree before hydration settles");
assert(historyHydration.includes('reason: "hydration-pending"'), "manual history loading must fail safely while hydration is pending");
assert(firefoxContent.includes("DOM_GATE && !DOM_GATE.isReady()"), "Firefox status badge must not write DOM during hydration");
assert(chromeContent.includes("DOM_GATE && !DOM_GATE.isReady()"), "Chromium status badge must not write DOM during hydration");

assert(windowed.includes('settings.mode === "windowed-visible"'), "auto mode must remain explicit");
assert(windowed.includes("function snapshotKey"), "history controller must identify equivalent snapshots");
assert(windowed.includes("historyKey === nextKey"), "equivalent history deliveries must not reset loaded pages");
assert(windowed.includes('type: "cg-get-window-history"'), "both browsers must have a durable history fallback through extension messaging");
assert(windowed.includes("NETWORK_ARCHIVE_EVENT"), "Chromium current-page history must use the single transient archive event");
assert(windowed.includes("transientHistory"), "Chromium must consume the isolated transient archive without replay timers");
assert(!windowed.includes("setInterval("), "history attachment must be event-driven rather than constantly polled");
assert(windowed.includes('nativeScroller.hasAttribute("data-scroll-from-end")'), "initial bounded loads must restore the current/end position when ChatGPT starts away from the end");
assert(windowed.includes("userInteracted"), "initial scroll correction must not fight user input");
assert(windowed.includes("missing-after-trim"), "trim-without-history must become a visible diagnostic rather than a silent missing button");

assert.equal(firefoxArchiveCapture, chromeArchiveCapture, "archive tail capture logic must stay byte-identical across browsers");
assert(firefoxArchiveCapture.includes("function conversationId()"), "tail capture must derive its conversation id locally from the current page");
assert(firefoxArchiveCapture.includes('location.pathname.match(/(?:^|\\/)c\\/([^/?#]+)/)'), "tail capture must parse the current /c/<id> pathname itself");
assert(!/\bCGArchive\b/.test(firefoxArchiveCapture), "tail capture must not depend on a free archive helper global");
assert(firefoxArchiveCapture.includes('type: "cg-merge-rendered-archive"'), "tail capture must still merge rendered updates through the background archive service");

assert(chromeBackground.includes('message.type === "cg-get-window-history"'), "Chromium service worker must serve durable archived history");
assert(chromeBackground.includes("CGArchiveStore.get(conversationId)"), "Chromium durable history must come from extension-origin IndexedDB");
assert(chromeBackground.includes('source: "extension-indexeddb"'), "Chromium history responses should expose their durable source for diagnostics");
assert(chromeBackground.includes("history-read-failed"), "IndexedDB history failures must be distinguishable from archive absence");

assert(chromeMain.includes("hydrationReady"), "the single Chromium interceptor must own the hydration barrier");
assert(chromeMain.includes("waitForTransformSafety"), "conversation transformation must wait for settings/hydration safety");
assert(chromeMain.includes('window.addEventListener("load"'), "Chromium transformation must cross the page load boundary on SSR loads");
assert((chromeMain.match(/requestAnimationFrame/g) || []).length >= 2, "Chromium transformation should cross two animation frames");
assert(chromeMain.includes("requestIdleCallback"), "Chromium transformation should wait for an idle slice before changing an SSR conversation graph");
assert(chromeMain.includes("publishArchive(data)"), "the untouched conversation must be archived before transformation");
assert(chromeMain.includes("startup-barrier-timeout"), "a hydration/settings timeout must fail open with an explicit reason");
assert.equal((chromeMain.match(/Object\.defineProperty\(Response\.prototype/g) || []).length, 2, "only one module should own the two Response body wrappers");

const chromeMainScripts = chromeManifest.content_scripts[0];
const chromeUi = chromeManifest.content_scripts[1];
const firefoxUi = firefoxManifest.content_scripts[0];
assert.equal(chromeMainScripts.run_at, "document_start", "Chromium graph interception must still install before page JavaScript consumes conversation data");
assert.deepEqual(chromeMainScripts.js.slice(-1), ["main.js"], "main.js must be the sole final Chromium response interceptor");
assert(!chromeMainScripts.js.includes("main-settings-barrier.js"), "superseded stacked Response wrapper must not be packaged");
assert(!chromeMainScripts.js.includes("history-replay-main.js"), "Chromium MAIN world must not package the old full-history replay bridge");
assert(!chromeUi.js.includes("history-request.js"), "Chromium isolated world must not use page-global history replay timers");
assert(!chromeUi.js.includes("history-overlay.js"), "superseded shadow/inline history layer must not be packaged");
assert(chromeUi.js.indexOf("diagnostics.js") < chromeUi.js.indexOf("content.js"), "Chromium diagnostics must exist before code can report failures");
assert(chromeUi.js.indexOf("history-native.js") < chromeUi.js.indexOf("history-virtualized.js"), "Markdown helper must load before the virtualized renderer");
assert(chromeUi.js.indexOf("history-fidelity.js") < chromeUi.js.indexOf("history-hydration-safe.js"), "Chromium hydration wrapper must wrap the final history renderer");
assert(chromeUi.js.indexOf("history-hydration-safe.js") < chromeUi.js.indexOf("windowed.js"), "Chromium hydration wrapper must load before the history controller");
assert(chromeUi.js.indexOf("windowed.js") < chromeUi.js.indexOf("debug-state.js"), "Chromium debug state must observe the final history controller stack");
assert(firefoxUi.js.indexOf("diagnostics.js") < firefoxUi.js.indexOf("content.js"), "Firefox diagnostics must exist before code can report failures");
assert(!firefoxUi.js.includes("history-overlay.js"), "Firefox must not package the superseded history layer");
assert(firefoxUi.js.indexOf("history-native.js") < firefoxUi.js.indexOf("history-virtualized.js"), "Firefox Markdown helper must load before virtualized history");
assert(firefoxUi.js.indexOf("history-fidelity.js") < firefoxUi.js.indexOf("history-hydration-safe.js"), "Firefox hydration wrapper must wrap the final history renderer");
assert(firefoxUi.js.indexOf("history-hydration-safe.js") < firefoxUi.js.indexOf("windowed.js"), "Firefox hydration wrapper must load before the history controller");
assert(firefoxUi.js.indexOf("windowed.js") < firefoxUi.js.indexOf("debug-state.js"), "Firefox debug state must observe the final history controller stack");
assert(!firefoxManifest.background.scripts.includes("archive-firefox-hook.js"), "Firefox must have one authoritative network archive path, not a duplicate trim wrapper");

// Defaults are supplied at each read site; never run a read-then-write defaults
// initializer at extension startup because it can overwrite a concurrent user/test write.
assert(!chromeBackgroundEntry.includes("defaults.js"), "Chromium service worker must not run an eager defaults writer");
assert(!firefoxManifest.background.scripts.includes("defaults.js"), "Firefox background must not run an eager defaults writer");
assert(chromePopup.includes('normalizeMode(value)'), "Chromium popup must normalize legacy/unknown modes when consumed");
assert(firefoxPopup.includes('normalizeMode(value)'), "Firefox popup must normalize legacy/unknown modes when consumed");
assert(chromeMain.includes('return VALID_MODES.has(value) ? value : "recent"'), "Chromium interceptor must default unknown modes to Recent without mutating storage");

const modeOptions = popupHtml.match(/<option value="(?:recent|windowed-visible)">/g) || [];
assert.equal(modeOptions.length, 2, "popup must expose exactly two history modes");
assert(!popupHtml.includes("visible-history"), "All visible history must not remain user-facing");
assert(!popupHtml.includes("latest-visible"), "Latest visible only must not remain user-facing");
assert(!popupHtml.includes('id="loadPrevious"'), "popup should not duplicate the on-page Load previous control");

assert(sizing.includes("width:360px") || sizing.includes("width: 360px"), "popup must have an explicit body width");
assert(sizing.includes("min-width:360px") || sizing.includes("min-width: 360px"), "popup must have a Firefox-safe minimum width");
assert(!sizing.includes("100vw"), "popup sizing override must not depend on an unresolved viewport width");
console.log("inline history/UI tests: PASS");
