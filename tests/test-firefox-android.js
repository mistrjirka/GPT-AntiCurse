"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

const manifest = JSON.parse(read("firefox/manifest.json"));
const popupSizing = read("firefox/popup-sizing.css");
const androidCss = read("firefox/android.css");

assert(manifest.browser_specific_settings, "Firefox package must declare browser-specific settings");
assert.deepEqual(
  manifest.browser_specific_settings.gecko_android,
  {},
  "Firefox package must advertise Android compatibility to AMO with an empty gecko_android object"
);

const contentEntry = (manifest.content_scripts || []).find((entry) => (entry.js || []).includes("windowed.js"));
assert(contentEntry, "Firefox history content script entry is missing");
assert((contentEntry.css || []).includes("android.css"), "Firefox Android layout CSS must be packaged with the content script");
assert.equal(contentEntry.run_at, "document_start", "Android must keep the same early content-script lifecycle");

for (const permission of ["webRequest", "webRequestBlocking", "webRequestFilterResponse"]) {
  assert((manifest.permissions || []).includes(permission), `Firefox Android response filtering still requires ${permission}`);
}

assert(popupSizing.includes("width:min(360px,100vw)"), "popup width must not overflow a narrow Android viewport");
assert(popupSizing.includes("min-width:0"), "popup must not force a 360px minimum width on Android");
assert(popupSizing.includes("pointer:coarse"), "mobile popup overrides should stay scoped to touch-style narrow viewports");
assert(popupSizing.includes("min-height:44px"), "mobile popup controls should expose touch-sized targets");

assert(androidCss.includes("safe-area-inset-bottom"), "mobile status placement must account for Android safe-area/browser UI");
assert(androidCss.includes("bottom: calc("), "mobile status pill should be lifted above the bottom composer/browser controls");
assert(androidCss.includes("min-height: 44px"), "Load previous should use a touch-sized target on Android");
assert(androidCss.includes("max-width: 86%"), "mobile user bubbles should use the available narrow viewport");

console.log("Firefox Android compatibility checks: PASS");
