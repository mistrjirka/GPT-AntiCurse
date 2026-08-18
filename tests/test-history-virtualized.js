"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function source(relative) {
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
}

global.CGHistoryMarkdown = { renderMarkdown() {} };
require("../firefox/history-virtualized.js");

const H = global.CGHistoryVirtualized;
const messages = [];
for (let exchange = 0; exchange < 8; exchange++) {
  messages.push({ role: "user", text: `u${exchange}` });
  for (let part = 0; part < 4; part++) messages.push({ role: "assistant", text: `a${exchange}.${part}` });
}

assert.equal(H.logicalUnitCount(messages), 16, "8 users + 8 assistant groups");
const start = H.previousLogicalStart(messages, messages.length, 6);
assert.equal(start, 25, "six logical units should select the last three complete exchanges");
assert.equal(H.logicalUnitCount(messages, start, messages.length), 6);
assert.equal(messages[start].role, "user", "page boundary must not split an assistant response group");

const virtualSource = source("firefox/history-virtualized.js");
assert(virtualSource.includes("this.maxPages()"), "history renderer must enforce a mounted-page ceiling");
assert(virtualSource.includes("cg-history-spacer-top"), "virtualized history needs a top height spacer");
assert(virtualSource.includes("cg-history-spacer-bottom"), "virtualized history needs a bottom height spacer");
assert(virtualSource.includes("this.pages.length <= this.maxPages()"), "virtualization must stop doing work while within the bound");
assert(virtualSource.includes("page.height"), "evicted pages must preserve measured height");
assert(virtualSource.includes("estimatedHeight"), "evicted pages need a non-zero geometry fallback when the browser defers layout");
assert(virtualSource.includes('turn.style.contentVisibility = "visible"'), "mounted offscreen pages must be force-measurable before eviction");
assert(virtualSource.includes("element.offsetHeight"), "page measurement should not depend on one layout API");
assert(virtualSource.includes("element.scrollHeight"), "page measurement should have a second real-layout fallback");
assert(!virtualSource.includes("data-message-author-role"), "synthetic turns must not impersonate ChatGPT native messages");
assert(virtualSource.includes("global.CGHistoryVirtualized"), "virtual renderer must expose a named module instead of replacing the final overlay global");

for (const browser of ["firefox", "chrome"]) {
  const manifest = JSON.parse(source(`${browser}/manifest.json`));
  const scripts = manifest.content_scripts.find((entry) => entry.js.includes("windowed.js")).js;
  assert(scripts.indexOf("history-markdown.js") < scripts.indexOf("history-virtualized.js"));
  assert(scripts.indexOf("history-virtualized.js") < scripts.indexOf("history-overlay.js"));
  assert(scripts.indexOf("history-overlay.js") < scripts.indexOf("windowed.js"));
  assert(manifest.content_scripts.find((entry) => entry.js.includes("windowed.js")).css.includes("history-virtualized.css"));
}

const firefoxManifest = JSON.parse(source("firefox/manifest.json"));
assert(firefoxManifest.background.scripts.indexOf("trim.js") < firefoxManifest.background.scripts.indexOf("trim-logical.js"));
assert(firefoxManifest.background.scripts.indexOf("trim-logical.js") < firefoxManifest.background.scripts.indexOf("archive.js"));

const chromeManifest = JSON.parse(source("chrome/manifest.json"));
const chromeMain = chromeManifest.content_scripts[0].js;
assert(chromeMain.indexOf("trim.js") < chromeMain.indexOf("trim-logical.js"));
assert(chromeMain.indexOf("trim-logical.js") < chromeMain.indexOf("main.js"));

console.log("virtual history tests: PASS");
