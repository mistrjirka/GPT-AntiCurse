"use strict";

const assert = require("assert");
const fs = require("fs");
const endpoint = require("../chrome/conversation-endpoint.js");

const pluralLive = "https://chatgpt.com/backend-api/conversations/123e4567-e89b-12d3-a456-426614174000?include_has_versions=true&num_turns=10";
assert.equal(endpoint.conversationId(pluralLive), "123e4567-e89b-12d3-a456-426614174000");
assert.equal(endpoint.parse(pluralLive).family, "conversations");
assert.equal(endpoint.conversationId("https://chatgpt.com/backend-api/conversation/legacy-id"), "legacy-id");
assert.equal(endpoint.parse("/backend-api/conversations/current-id/?cursor=older", "https://chatgpt.com/c/current-id").id, "current-id");
assert.equal(endpoint.messagesPageConversationId("/backend-api/conversations/current-id/messages?before=older", "https://chatgpt.com/c/current-id"), "current-id");
assert.equal(endpoint.parseMessagesPage("/backend-api/conversations/current-id/messages?before=older", "https://chatgpt.com/c/current-id").before, "older");
assert.equal(endpoint.isConversationDocument("/backend-api/conversations/current-id/messages?before=older", "https://chatgpt.com/c/current-id"), false);
assert.equal(endpoint.isConversationMessagesPage("/backend-api/conversations/current-id/messages?before=older", "https://chatgpt.com/c/current-id"), true);

for (const url of [
  "https://chatgpt.com/backend-api/conversations",
  "https://chatgpt.com/backend-api/conversations/search?query=test",
  "https://chatgpt.com/backend-api/conversation/init",
  "https://chatgpt.com/backend-api/conversations/id/stream_status",
  "https://chatgpt.com/backend-api/conversation/id/stream_status",
  "https://example.com/backend-api/conversations/id",
  "not a URL"
]) {
  assert.equal(endpoint.parse(url), null, `must fail open for unrelated route: ${url}`);
}

const firefoxBackground = fs.readFileSync("firefox/background.js", "utf8");
const archiveCapture = fs.readFileSync("chrome/archive-capture.js", "utf8");
const chromeE2E = fs.readFileSync("tests/e2e-chromium.js", "utf8");
const firefoxE2E = fs.readFileSync("tests/e2e-firefox.js", "utf8");
const singularE2E = fs.readFileSync("tests/e2e-hydration-chromium.js", "utf8");

assert.equal((firefoxBackground.match(/https:\/\/chatgpt\.com\/backend-api\/conversations\/\*/g) || []).length, 3);
assert(chromeE2E.includes("/backend-api/conversations/e2e?include_has_versions=true&num_turns=10"));
assert(firefoxE2E.includes("/backend-api/conversations/e2e-firefox?include_has_versions=true&num_turns=10"));
assert(singularE2E.includes("/backend-api/conversation/hydration-e2e"), "singular-path browser regression must remain");
assert(archiveCapture.includes('["conversation", "conversations"]'), "Export must keep singular-first plural fallback");
assert(archiveCapture.includes('params.set("include_has_versions", "true")'));
assert(archiveCapture.includes('params.set("num_turns", "10")'));
assert(archiveCapture.includes('[404, 405, 410]'));
console.log("conversation endpoint regression tests: PASS");
