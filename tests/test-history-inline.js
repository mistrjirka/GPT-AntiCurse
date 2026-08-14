"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
function source(relative) { return fs.readFileSync(path.join(__dirname, "..", relative), "utf8"); }
const history = source("firefox/history-native.js");
const windowed = source("firefox/windowed.js");
const chromeReplay = source("chrome/history-replay-main.js");
const chromeRequest = source("chrome/history-request.js");
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

assert(windowed.includes('settings.mode === "windowed-visible"'), "auto mode must remain explicit");
assert(windowed.includes("function snapshotKey"), "history controller must identify equivalent snapshots");
assert(windowed.includes("historyKey === nextKey"), "equivalent history deliveries must not reset loaded pages");
assert(chromeReplay.includes("let lastHistory"), "Chromium MAIN world must retain the latest history payload");
assert(chromeReplay.includes('message.type === "history-request"'), "Chromium MAIN world must answer history replay requests");
assert(chromeRequest.includes('type: "history-request"'), "Chromium isolated world must request replay after windowed.js is listening");
assert(chromeRequest.includes("let resolved = false"), "Chromium history retries must have a completion latch");
assert(chromeRequest.includes("clearTimeout"), "later Chromium retries must be cancelled after first history delivery");
assert(chromeRequest.includes('message.type === "history"'), "history request bridge must recognize the first successful response");
assert(chromeManifest.content_scripts[0].js.indexOf("history-replay-main.js") < chromeManifest.content_scripts[0].js.indexOf("main.js"), "Chromium replay bridge must load before main interceptor");
assert(chromeManifest.content_scripts[1].js.indexOf("windowed.js") < chromeManifest.content_scripts[1].js.indexOf("history-request.js"), "Chromium replay request must load after windowed listener");
assert(firefoxManifest.content_scripts[0].js.indexOf("history-native.js") < firefoxManifest.content_scripts[0].js.indexOf("windowed.js"), "Firefox native-looking renderer must override the old factory before controller startup");
assert(chromeManifest.content_scripts[1].js.indexOf("history-native.js") < chromeManifest.content_scripts[1].js.indexOf("windowed.js"), "Chromium native-looking renderer must override the old factory before controller startup");

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
