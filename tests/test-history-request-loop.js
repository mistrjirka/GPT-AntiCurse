"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { performance } = require("perf_hooks");

const ROOT = path.resolve(__dirname, "..");
const WINDOWED = fs.readFileSync(path.join(ROOT, "chrome/windowed.js"), "utf8");

function makeOverlay() {
  return {
    setMode() {},
    hasMoreOlderTurns() { return false; },
    loadPreviousPage() { return { ok: false, reason: "none" }; },
    ensureAttached() {},
    setHistory() {},
    destroy() {}
  };
}

function makeHarness({ packageTarget = "chromium", runtimeBrowser = "chromium", historyReply = null } = {}) {
  let storageListener = null;
  let sendCount = 0;
  const issues = [];
  const manifest = {
    version: "test",
    ...(packageTarget === "firefox" ? { browser_specific_settings: { gecko: { id: "test@example" } } } : {})
  };

  const runtime = {
    getManifest() { return manifest; },
    onMessage: { addListener() {} },
    sendMessage(message) {
      sendCount++;
      if (historyReply && message && message.type === "cg-get-window-history") return Promise.resolve(historyReply);
      return Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
    }
  };
  const extensionApi = {
    runtime,
    storage: {
      local: {
        get() { return Promise.resolve({ enabled: true, mode: "recent", maxDisplayMessages: 64 }); }
      },
      onChanged: {
        addListener(listener) { storageListener = listener; }
      }
    }
  };

  const context = {
    chrome: extensionApi,
    // Chrome 148+ exposes the same WebExtensions APIs under `browser` too.
    browser: extensionApi,
    navigator: { userAgent: runtimeBrowser === "firefox" ? "Mozilla/5.0 Firefox/150.0" : "Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36" },
    location: { href: "https://chatgpt.com/c/test-conversation", pathname: "/c/test-conversation" },
    performance,
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame(callback) { callback(); return 1; },
    cancelAnimationFrame() {},
    MutationObserver: class { observe() {} disconnect() {} },
    Node: { ELEMENT_NODE: 1 },
    document: {
      body: null,
      documentElement: {},
      scrollingElement: null,
      querySelector() { return null; }
    },
    window: {
      addEventListener() {},
      dispatchEvent() {}
    },
    CGHistoryOverlay: { create: makeOverlay },
    CGAntiCurseDiagnostics: {
      record(scope, code, error, extra) {
        issues.push({ scope, code, message: String(error && error.message ? error.message : error), extra });
        return Promise.resolve(null);
      },
      clear() { return Promise.resolve(true); }
    }
  };
  context.globalThis = context;

  vm.runInNewContext(WINDOWED, context, { filename: "windowed.js" });
  return {
    context,
    get sendCount() { return sendCount; },
    get issues() { return issues.slice(); },
    fireStorage(changes) {
      assert(storageListener, "storage listener should be installed");
      storageListener(changes, "local");
    }
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  const chromium = makeHarness();
  await settle();
  assert.equal(chromium.sendCount, 1, "initial Chrome history fallback should make one background request");

  // Recreate the v0.5.16 failure mechanism: failed request -> diagnostic persisted
  // to storage.local -> storage listener -> another failed request -> diagnostic...
  // Unrelated local storage writes must now remain completely inert.
  for (let index = 0; index < 1000; index++) {
    chromium.fireStorage({ cgLastIssue: { newValue: { code: "runtime-request-failed", index } } });
  }
  await settle();
  assert.equal(chromium.sendCount, 1, "diagnostic storage writes must never retrigger history lookup");

  // Genuine setting changes may retry, but overlapping triggers are single-flight.
  chromium.fireStorage({ maxDisplayMessages: { newValue: 32 } });
  chromium.fireStorage({ mode: { newValue: "windowed-visible" } });
  await settle();
  assert.equal(chromium.sendCount, 2, "overlapping history setting changes should collapse to one retry");

  const firefox = makeHarness({
    packageTarget: "firefox",
    runtimeBrowser: "firefox",
    historyReply: { ok: true, messages: [], nativeVisibleCount: 0, pageSize: 64, maxRendered: 192, source: "firefox-network-filter" }
  });
  await settle();
  assert.equal(firefox.sendCount, 1, "Firefox package must continue using the Firefox background-history path");
  assert.deepEqual(
    { packageTarget: firefox.context.CGAntiCurseHistoryDebug.debug().packageTarget, runtimeBrowser: firefox.context.CGAntiCurseHistoryDebug.debug().runtimeBrowser },
    { packageTarget: "firefox", runtimeBrowser: "firefox" },
    "Firefox package/runtime diagnostics must stay distinct and correct"
  );

  // This is the signature seen in the user's Chrome report: Firefox package
  // identity while the actual browser UA is Chromium. Do not silently reinterpret
  // it as Firefox; report both facts, and above all keep failed requests bounded.
  const firefoxInChrome = makeHarness({ packageTarget: "firefox", runtimeBrowser: "chromium" });
  await settle();
  const mixedState = firefoxInChrome.context.CGAntiCurseHistoryDebug.debug();
  assert.equal(mixedState.packageTarget, "firefox");
  assert.equal(mixedState.runtimeBrowser, "chromium");
  assert.equal(firefoxInChrome.sendCount, 1, "mixed package/runtime startup must not fan out background requests");
  for (let index = 0; index < 1000; index++) {
    firefoxInChrome.fireStorage({ cgIssueHistory: { newValue: [{ index }] } });
  }
  await settle();
  assert.equal(firefoxInChrome.sendCount, 1, "mixed package/runtime diagnostics must not create a feedback storm");

  console.log("history request feedback/package-runtime checks: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
