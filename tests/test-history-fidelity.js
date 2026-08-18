"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const source = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

const fidelity = source("firefox/history-fidelity.js");
const overlay = source("firefox/history-overlay.js");
const css = source("firefox/history-fidelity.css");
const firefoxManifest = JSON.parse(source("firefox/manifest.json"));
const chromeManifest = JSON.parse(source("chrome/manifest.json"));

assert(fidelity.includes("findNativeRole"), "fidelity layer must derive styling from live native turns");
assert(fidelity.includes('section[data-testid^="conversation-turn-"]'), "native turn shell must be used as the visual template");
assert(fidelity.includes("turn-messages"), "native thread-width shell must be reused");
assert(fidelity.includes("userTextNode"), "user fidelity must locate the actual native text node rather than assuming child order");
assert(fidelity.includes("userBubbleNode"), "user fidelity must locate the actual native text bubble semantically");
assert(fidelity.includes("whitespace-pre-wrap"), "native user text lookup must anchor on the textual message node");
assert(fidelity.includes("user-message-bubble-color"), "native user bubble lookup must prefer the actual colored text bubble");
assert(!fidelity.includes("template.userBubble = copyClass(first"), "attachments/file rows must never be sampled as the user text bubble");
assert(fidelity.includes("text-token-text-tertiary"), "tool activity must use ChatGPT tertiary activity styling");
assert(fidelity.includes("Non-text visible message"), "legacy non-text placeholders must be explicitly recognized");
assert(fidelity.includes('kind: "noise"'), "legacy non-text placeholders must be suppressed");
assert(fidelity.includes("JSON.parse(raw)"), "legacy serialized tool calls must be recognized structurally");
assert(fidelity.includes("search_query$"), "provider-specific web-search payloads must be recognized as activity instead of raw JSON");
assert(fidelity.includes("Searched tools"), "tool-discovery payloads must become compact activity rows");
assert(fidelity.includes("Ran command in Development Sandbox"), "Development Sandbox calls need compact activity labels");
assert(fidelity.includes("row.title"), "raw tool payload should remain inspectable without occupying transcript layout");
assert(!fidelity.includes("setAttribute(\"data-message-author-role\""), "synthetic turns must not impersonate React-owned messages");
assert(!fidelity.includes("setAttribute(\"data-turn-id\""), "synthetic turns must not impersonate React-owned turn containers");
assert(!fidelity.includes(".innerHTML"), "fidelity DOM should not use innerHTML even for static activity icons");
assert(!fidelity.includes(".innerText"), "fidelity text copying should avoid layout-dependent innerText reads");
assert(fidelity.includes("document.createElementNS(SVG_NS"), "activity SVG should be assembled with DOM APIs");
assert(fidelity.includes("oldMarkdown.textContent"), "synthetic history text should be copied with textContent");
assert(fidelity.includes("function wrap(base)"), "fidelity must expose an explicit decorator");
assert(fidelity.includes("global.CGHistoryFidelity"), "fidelity must have a named module API");
assert(!fidelity.includes("global.CGHistoryOverlay ="), "fidelity must not silently replace the final overlay global");
assert(overlay.includes("CGHistoryFidelity"), "the final compositor must apply fidelity explicitly");
assert(overlay.includes("CGHistoryHydration"), "the final compositor must apply hydration explicitly");
assert(overlay.includes("global.CGHistoryOverlay = overlay"), "one module should own final overlay publication");

assert(css.includes("--thread-content-margin"), "archived turns must follow native responsive thread margins");
assert(css.includes("--thread-content-max-width"), "archived turns must follow native responsive content width");
assert(css.includes("--user-chat-width"), "archived user bubbles must follow native user width");

for (const manifest of [firefoxManifest, chromeManifest]) {
  const scripts = manifest.content_scripts.find((entry) => entry.js.includes("windowed.js")).js;
  const styles = manifest.content_scripts.find((entry) => Array.isArray(entry.css) && entry.css.includes("content.css")).css;
  assert(scripts.indexOf("history-virtualized.js") < scripts.indexOf("history-fidelity.js"), "fidelity module must load after the virtual renderer");
  assert(scripts.indexOf("history-fidelity.js") < scripts.indexOf("history-hydration-safe.js"), "fidelity must be available before hydration composition");
  assert(scripts.indexOf("history-hydration-safe.js") < scripts.indexOf("history-overlay.js"), "decorators must load before final composition");
  assert(scripts.indexOf("history-overlay.js") < scripts.indexOf("windowed.js"), "final overlay must exist before the history controller");

  const fidelityIndex = styles.indexOf("history-fidelity.css");
  assert(fidelityIndex > styles.indexOf("history-virtualized.css"), "fidelity CSS must override the shared virtual-history fallback geometry");
  if (manifest === firefoxManifest) {
    assert.equal(styles.at(-1), "android.css", "Firefox Android overrides must load after the shared fidelity styles");
    assert.equal(fidelityIndex, styles.length - 2, "Firefox fidelity CSS must remain the final shared/base history stylesheet");
  } else {
    assert.equal(fidelityIndex, styles.length - 1, "Chromium fidelity CSS must remain the final history stylesheet");
  }
}

console.log("history fidelity tests: PASS");
