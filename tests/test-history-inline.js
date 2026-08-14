"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
function source(relative) { return fs.readFileSync(path.join(__dirname, "..", relative), "utf8"); }
const history = source("firefox/history-native.js");
const windowed = source("firefox/windowed.js");
const domReady = source("firefox/dom-ready.js");
const historyHydration = source("firefox/history-hydration-safe.js");
const firefoxContent = source("firefox/content.js");
const chromeContent = source("chrome/content.js");
const chromeBackground = source("chrome/background.js");
const chromeMain = source("chrome/main.js");
const chromeBarrier = source("chrome/main-settings-barrier.js");
const popup = source("firefox/popup.html");
const defaults = source("firefox/defaults.js");
const contentCss = source("firefox/content.css");
const sizing = source("firefox/popup-sizing.css");
const chromeManifest = JSON.parse(source("chrome/manifest.json"));
const firefoxManifest = JSON.parse(source("firefox/manifest.json"));

assert(history.includes('document.querySelector("#thread")'), "inline history must anchor to ChatGPT #thread");
assert(history.includes("insertBefore(this.host, thread)"), "inline history must stay immediately before native #thread");
assert(!history.includes("attachShadow"), "active history renderer must use light DOM so ChatGPT styles can apply");
assert(history.includes("markdown prose dark:prose-invert"), "older text should use ChatGPT markdown/prose styling");
assert(history.includes("user-message-bubble-color"), "older user turns should reuse ChatGPT's bubble surface class");
assert(history.includes("renderMarkdown"), "older Markdown should be rendered structurally rather than as pre-wrapped plaintext");
assert(history.includes("function grouped"), "consecutive assistant records should be visually grouped");
assert(history.includes("Load previous ${next}"), "Recent N mode needs an inline Load previous button");
assert(history.includes('this.mode === "recent"'), "the button must belong only to Recent N mode");
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
assert(windowed.includes('type: "cg-get-window-history"'), "both browsers must request history through extension messaging");
assert(windowed.includes("CHROME_HISTORY_RETRY_MS"), "Chromium must tolerate archive persistence finishing after controller startup");
assert(windowed.includes('nativeScroller.hasAttribute("data-scroll-from-end")'), "initial bounded loads must be able to restore the current/end position");
assert(windowed.includes("userInteracted"), "initial scroll correction must not fight user input");

assert(chromeBackground.includes('message.type === "cg-get-window-history"'), "Chromium service worker must serve archived history");
assert(chromeBackground.includes("CGArchiveStore.get(conversationId)"), "Chromium history must come from extension-origin IndexedDB");
assert(chromeBackground.includes('source: "extension-indexeddb"'), "Chromium history responses should expose their durable source for diagnostics");
assert(chromeBackground.includes("rawVisibleWindowCount"), "Chromium background must reproduce logical Recent-N raw cutoff semantics");
assert(!chromeMain.includes("publishHistory"), "MAIN world must not clone the full history into page messages");
assert(!chromeMain.includes('type, { history'), "MAIN world must not own history replay state");

assert(chromeBarrier.includes("hydrationReady"), "initial Chromium response delivery must have a hydration barrier");
assert(chromeBarrier.includes("waitForSafeDelivery"), "conversation responses must wait for both settings and hydration");
assert(chromeBarrier.includes('window.addEventListener("load"'), "MAIN response barrier must cross the page load boundary");
assert((chromeBarrier.match(/requestAnimationFrame/g) || []).length >= 2, "MAIN response barrier should cross two animation frames");
assert(chromeBarrier.includes("requestIdleCallback"), "MAIN response barrier should wait for an idle slice before returning a trimmed SSR conversation");

const chromeMainScripts = chromeManifest.content_scripts[0];
const chromeUi = chromeManifest.content_scripts[1];
const firefoxUi = firefoxManifest.content_scripts[0];
assert.equal(chromeMainScripts.run_at, "document_start", "Chromium graph interception must still install before page JavaScript consumes conversation data");
assert(!chromeMainScripts.js.includes("history-replay-main.js"), "Chromium MAIN world must not package the old full-history replay bridge");
assert(!chromeUi.js.includes("history-request.js"), "Chromium isolated world must not use page-global history replay timers");
assert(chromeMainScripts.js.indexOf("main-settings-barrier.js") < chromeMainScripts.js.indexOf("main.js"), "hydration/settings barrier must wrap the transformer before it installs");
assert(chromeUi.js.indexOf("dom-ready.js") < chromeUi.js.indexOf("content.js"), "Chromium DOM readiness gate must exist before the status UI");
assert(chromeUi.js.indexOf("history-fidelity.js") < chromeUi.js.indexOf("history-hydration-safe.js"), "Chromium hydration wrapper must wrap the final history renderer");
assert(chromeUi.js.indexOf("history-hydration-safe.js") < chromeUi.js.indexOf("windowed.js"), "Chromium hydration wrapper must load before the history controller");
assert(firefoxUi.js.indexOf("dom-ready.js") < firefoxUi.js.indexOf("content.js"), "Firefox DOM readiness gate must exist before the status UI");
assert(firefoxUi.js.indexOf("history-native.js") < firefoxUi.js.indexOf("windowed.js"), "Firefox native-looking renderer must override the old factory before controller startup");
assert(firefoxUi.js.indexOf("history-fidelity.js") < firefoxUi.js.indexOf("history-hydration-safe.js"), "Firefox hydration wrapper must wrap the final history renderer");
assert(firefoxUi.js.indexOf("history-hydration-safe.js") < firefoxUi.js.indexOf("windowed.js"), "Firefox hydration wrapper must load before the history controller");
assert(chromeUi.js.indexOf("history-native.js") < chromeUi.js.indexOf("windowed.js"), "Chromium native-looking renderer must override the old factory before controller startup");

const modeOptions = popup.match(/<option value="(?:recent|windowed-visible)">/g) || [];
assert.equal(modeOptions.length, 2, "popup must expose exactly two history modes");
assert(!popup.includes("visible-history"), "All visible history must not remain user-facing");
assert(!popup.includes("latest-visible"), "Latest visible only must not remain user-facing");
assert(!popup.includes('id="loadPrevious"'), "popup should not duplicate the on-page Load previous control");
assert(defaults.includes('updates.mode = "recent"'), "legacy modes must migrate to Recent N");

assert(sizing.includes("width:360px") || sizing.includes("width: 360px"), "popup must have an explicit body width");
assert(sizing.includes("min-width:360px") || sizing.includes("min-width: 360px"), "popup must have a Firefox-safe minimum width");
assert(!sizing.includes("100vw"), "popup sizing override must not depend on an unresolved viewport width");
console.log("inline history/UI tests: PASS");
