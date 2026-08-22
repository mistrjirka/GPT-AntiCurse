"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "firefox", "history-source-priority.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "firefox", "manifest.json"), "utf8"));

let localHistory = null;
let networkCalls = 0;
const original = async (id) => {
  networkCalls++;
  if (id === "rate-limited") return { ok: false, reason: "http-status", status: 429 };
  return { ok: true, archive: { id, complete: true, messages: [] }, sourcePages: 1 };
};

const bridge = { buildFullVisibleArchive: original };
const browser = {
  runtime: {
    getManifest: () => ({ browser_specific_settings: { gecko: { id: "test@example" } } }),
    sendMessage: async (message) => {
      assert.equal(message.type, "cg-get-window-history");
      return localHistory;
    }
  }
};
const context = {
  browser,
  chrome: browser,
  document: { title: "Test chat" },
  location: { href: "https://chatgpt.com/c/test" },
  Date,
  Map,
  String,
  Math,
  Promise,
  setTimeout,
  clearTimeout,
  CGAntiCurseArchiveBridge: bridge
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "history-source-priority.js" });

(async () => {
  localHistory = {
    ok: true,
    conversationId: "captured",
    messages: [{ id: "u1", role: "user", text: "already captured", createTime: 1 }]
  };
  let result = await bridge.buildFullVisibleArchive("captured");
  assert.equal(result.ok, true);
  assert.equal(result.cached, true);
  assert.equal(result.sourceAuth, "captured-firefox-history");
  assert.equal(result.archive.messages[0].text, "already captured");
  assert.equal(networkCalls, 0, "complete Firefox background history must prevent a duplicate HTTP fetch");

  localHistory = { ok: false, reason: "archive-not-found" };
  result = await bridge.buildFullVisibleArchive("rate-limited");
  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert(result.retryInMs >= 15000, "first 429 must start a conservative retry cooldown");
  assert.equal(networkCalls, 1);

  result = await bridge.buildFullVisibleArchive("rate-limited");
  assert.equal(result.reason, "history-network-rate-limit-backoff");
  assert.equal(networkCalls, 1, "cooldown must suppress repeated HTTP requests after 429");

  localHistory = {
    ok: true,
    conversationId: "rate-limited",
    messages: [{ id: "a1", role: "assistant", text: "arrived locally" }]
  };
  result = await bridge.buildFullVisibleArchive("rate-limited");
  assert.equal(result.ok, true, "captured history must remain usable even while network fallback is cooling down");
  assert.equal(result.archive.messages[0].text, "arrived locally");
  assert.equal(networkCalls, 1);

  const debug = context.CGAntiCurseHistorySourcePriority.debug();
  assert.equal(debug.localHits, 2);
  assert.equal(debug.networkFallbacks, 1);
  assert.equal(debug.rateLimitedSkips, 1);

  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
  const captureIndex = scripts.indexOf("archive-capture.js");
  const priorityIndex = scripts.indexOf("history-source-priority.js");
  const windowedIndex = scripts.indexOf("windowed.js");
  assert(captureIndex >= 0 && priorityIndex > captureIndex && windowedIndex > priorityIndex,
    "Firefox local-first wrapper must install after archive capture and before windowed history");

  console.log("Firefox captured-history priority and 429 backoff: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
