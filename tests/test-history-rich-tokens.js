"use strict";

const assert = require("assert");
const path = require("path");
const modulePath = path.join(__dirname, "..", "firefox", "history-markdown.js");
delete global.CGHistoryMarkdown;
delete require.cache[require.resolve(modulePath)];
const H = require(modulePath);

const input = [
  "Guide: \uE200url\uE202Manual Go-To guide\uE202https://example.com/guide\uE201",
  "Claim. \uE200cite\uE202turn1search0\uE202turn1search1\uE201",
  "Local detail. \uE200filecite\uE202turn2file0\uE202L9-L18\uE201",
  "\uE200image_group\uE202{\"layout\":\"carousel\",\"image_refs\":[\"turn1image0\"]}\uE201",
  "Product: \uE200entity\uE202[\"turn0product1\",\"Example Widget\"]\uE201",
  "\uE200memcite\uE201"
].join("\n");

const projected = H.projectRichTokens(input);
assert(projected.includes("[Manual Go-To guide](https://example.com/guide)"));
assert(projected.includes("[Images from original response]"));
assert(projected.includes("Product: Example Widget"));
assert(!projected.includes("turn1search0"));
assert(!projected.includes("turn2file0"));
assert(!projected.includes("\uE200"));
assert(!projected.includes("\uE201"));

console.log("archived history rich-token projection: PASS");
