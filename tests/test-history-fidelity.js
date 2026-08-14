"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const source = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

const fidelity = source("firefox/history-fidelity.js");
const css = source("firefox/history-fidelity.css");
const firefoxManifest = JSON.parse(source("firefox/manifest.json"));
const chromeManifest = JSON.parse(source("chrome/manifest.json"));

assert(fidelity.includes("findNativeRole"), "fidelity layer must derive styling from live native turns");
assert(fidelity.includes('section[data-testid^="conversation-turn-"]'), "native turn shell must be used as the visual template");
assert(fidelity.includes("group\\/turn-messages"), "native thread-width shell must be reused");
assert(fidelity.includes("text-token-text-tertiary"), "tool activity must use ChatGPT tertiary activity styling");
assert(fidelity.includes("Non-text visible message"), "legacy non-text placeholders must be explicitly recognized");
assert(fidelity.includes('kind: "noise"'), "legacy non-text placeholders must be suppressed");
assert(fidelity.includes("JSON.parse(raw)"), "legacy serialized tool calls must be recognized structurally");
assert(fidelity.includes("Ran command in Development Sandbox"), "Development Sandbox calls need compact activity labels");
assert(fidelity.includes("row.title"), "raw tool payload should remain inspectable without occupying transcript layout");
assert(!fidelity.includes("setAttribute(\"data-message-author-role\""), "synthetic turns must not impersonate React-owned messages");
assert(!fidelity.includes("setAttribute(\"data-turn-id\""), "synthetic turns must not impersonate React-owned turn containers");

assert(css.includes("--thread-content-margin"), "archived turns must follow native responsive thread margins");
assert(css.includes("--thread-content-max-width"), "archived turns must follow native responsive content width");
assert(css.includes("--user-chat-width"), "archived user bubbles must follow native user width");

for (const manifest of [firefoxManifest, chromeManifest]) {
  const scripts = manifest.content_scripts.find((entry) => entry.js.includes("windowed.js")).js;
  const styles = manifest.content_scripts.find((entry) => Array.isArray(entry.css) && entry.css.includes("content.css")).css;
  assert(scripts.indexOf("history-virtualized.js") < scripts.indexOf("history-fidelity.js"), "fidelity wrapper must load after the virtual renderer");
  assert(scripts.indexOf("history-fidelity.js") < scripts.indexOf("windowed.js"), "fidelity wrapper must be installed before the controller creates history");
  assert(styles.indexOf("history-fidelity.css") === styles.length - 1, "fidelity CSS must override older fallback geometry last");
}

console.log("history fidelity tests: PASS");
