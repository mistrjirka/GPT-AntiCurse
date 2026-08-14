"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

global.CGHistoryOverlay = { renderMarkdown() {} };
require("../firefox/history-virtualized.js");

const H = global.CGHistoryOverlay;
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

const source = fs.readFileSync(path.join(__dirname, "..", "firefox", "history-virtualized.js"), "utf8");
assert(source.includes("this.maxPages()"), "history renderer must enforce a mounted-page ceiling");
assert(source.includes("cg-history-spacer-top"), "virtualized history needs a top height spacer");
assert(source.includes("cg-history-spacer-bottom"), "virtualized history needs a bottom height spacer");
assert(source.includes("this.pages.length <= this.maxPages()"), "virtualization must stop doing work while within the bound");
assert(source.includes("page.height"), "evicted pages must preserve measured height");
assert(!source.includes("data-message-author-role"), "synthetic turns must not impersonate ChatGPT native messages");

console.log("virtual history tests: PASS");
