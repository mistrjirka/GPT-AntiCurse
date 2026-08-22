"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const endpointSource = fs.readFileSync(path.join(ROOT, "firefox", "conversation-endpoint.js"), "utf8");
const guardSource = fs.readFileSync(path.join(ROOT, "firefox", "conversation-rate-limit-guard.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "firefox", "manifest.json"), "utf8"));

const scripts = manifest.background && Array.isArray(manifest.background.scripts) ? manifest.background.scripts : [];
const endpointIndex = scripts.indexOf("conversation-endpoint.js");
const guardIndex = scripts.indexOf("conversation-rate-limit-guard.js");
const backgroundIndex = scripts.indexOf("background.js");
assert(endpointIndex >= 0 && guardIndex > endpointIndex, "rate-limit guard must load after endpoint parser");
assert(backgroundIndex > guardIndex, "rate-limit guard must register before normal Firefox interception");
assert(!guardSource.includes("setInterval("), "rate-limit guard must be event-driven");

let now = 1_000_000;
const RealDate = Date;
class FakeDate extends RealDate {}
FakeDate.now = () => now;

let beforeSendHeaders = null;
let headersReceived = null;
const browser = {
  webRequest: {
    onBeforeSendHeaders: { addListener(listener) { beforeSendHeaders = listener; } },
    onHeadersReceived: { addListener(listener) { headersReceived = listener; } }
  }
};

const context = { browser, URL, Date: FakeDate, console, Map, Set, Object, Number, String, Array, Math };
context.globalThis = context;
vm.runInNewContext(endpointSource, context, { filename: "conversation-endpoint.js" });
vm.runInNewContext(guardSource, context, { filename: "conversation-rate-limit-guard.js" });

assert.equal(typeof beforeSendHeaders, "function");
assert.equal(typeof headersReceived, "function");
const guard = context.CGAntiCurseConversationRateLimitGuard;
assert(guard && guard._test, "rate-limit guard must expose local test hooks");

const plural = "https://chatgpt.com/backend-api/conversations/conv-1?include_has_versions=true&num_turns=10";
const singular = "https://chatgpt.com/backend-api/conversation/conv-1";
const status = "https://chatgpt.com/backend-api/conversation/conv-1/stream_status";

headersReceived({ tabId: 81, method: "GET", url: plural, statusCode: 429, responseHeaders: [] });
let state = guard.activeStateFor(81, "conv-1");
assert(state, "first 429 must open a circuit");
assert.equal(state.failures, 1);
assert.equal(state.delayMs, 15_000);

let result = beforeSendHeaders({ tabId: 81, method: "GET", url: singular, requestHeaders: [] });
assert.equal(result.cancel, true, "unmarked singular fallback must be blocked inside plural cooldown");
assert.equal(guard.debug().blockedRequests, 1);

result = beforeSendHeaders({
  tabId: 81,
  method: "GET",
  url: singular,
  requestHeaders: [{ name: "X-GPT-AntiCurse-Export", value: "one-shot" }]
});
assert.equal(result.cancel, undefined, "explicit AntiCurse export/history fetch keeps its independent backoff path");

result = beforeSendHeaders({ tabId: 81, method: "GET", url: status, requestHeaders: [] });
assert.equal(result.cancel, undefined, "stream_status must never share the conversation-document circuit");

now += 15_001;
result = beforeSendHeaders({ tabId: 81, method: "GET", url: plural, requestHeaders: [] });
assert.equal(result.cancel, undefined, "one probe is allowed after cooldown expires");
headersReceived({ tabId: 81, method: "GET", url: plural, statusCode: 429, responseHeaders: [] });
state = guard.activeStateFor(81, "conv-1");
assert.equal(state.failures, 2);
assert.equal(state.delayMs, 30_000, "repeated 429 must double the cooldown");

now += 30_001;
headersReceived({ tabId: 81, method: "GET", url: plural, statusCode: 200, responseHeaders: [] });
assert.equal(guard.activeStateFor(81, "conv-1"), null, "successful conversation read must reset the circuit");
assert.equal(guard.debug().successfulResets, 1);

headersReceived({
  tabId: 81,
  method: "GET",
  url: plural,
  statusCode: 429,
  responseHeaders: [{ name: "Retry-After", value: "120" }]
});
state = guard.activeStateFor(81, "conv-1");
assert.equal(state.delayMs, 120_000, "Retry-After must lengthen the local cooldown when provided");

const otherTab = beforeSendHeaders({ tabId: 82, method: "GET", url: plural, requestHeaders: [] });
assert.equal(otherTab.cancel, undefined, "circuit must remain scoped to one tab/conversation");

console.log("Firefox conversation-document 429 circuit breaker: PASS");
