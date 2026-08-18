"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { performance } = require("perf_hooks");

const ROOT = path.resolve(__dirname, "..");
const SCOPE = fs.readFileSync(path.join(ROOT, "chrome/conversation-scope.js"), "utf8");
const WINDOWED = fs.readFileSync(path.join(ROOT, "chrome/windowed.js"), "utf8");

function conversationIdFromUrl(urlString) {
  const match = new URL(urlString, "https://chatgpt.com").pathname.match(/(?:^|\/)c\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function makeOverlay(state) {
  return {
    setMode() {},
    hasMoreOlderTurns() { return false; },
    loadPreviousPage() { return { ok: false, reason: "none" }; },
    ensureAttached() {},
    setHistory(value) { state.lastHistory = value; state.setHistoryCount++; },
    destroy() { state.destroyCount++; state.lastHistory = null; }
  };
}

function makeHarness({ packageTarget = "chromium", runtimeBrowser = "chromium", historyReply = null, historyResponder = null } = {}) {
  let storageListener = null;
  let runtimeListener = null;
  let sendCount = 0;
  const issues = [];
  const overlayState = { lastHistory: null, setHistoryCount: 0, destroyCount: 0 };
  const manifest = {
    version: "test",
    ...(packageTarget === "firefox" ? { browser_specific_settings: { gecko: { id: "test@example" } } } : {})
  };

  const runtime = {
    getManifest() { return manifest; },
    onMessage: { addListener(listener) { runtimeListener = listener; } },
    sendMessage(message) {
      sendCount++;
      if (historyResponder && message && message.type === "cg-get-window-history") return historyResponder(message);
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
    CGArchive: { conversationIdFromUrl },
    CGHistoryOverlay: { create() { return makeOverlay(overlayState); } },
    CGAntiCurseDiagnostics: {
      record(scope, code, error, extra) {
        issues.push({ scope, code, message: String(error && error.message ? error.message : error), extra });
        return Promise.resolve(null);
      },
      clear() { return Promise.resolve(true); }
    }
  };
  context.globalThis = context;

  vm.runInNewContext(SCOPE, context, { filename: "conversation-scope.js" });
  vm.runInNewContext(WINDOWED, context, { filename: "windowed.js" });
  return {
    context,
    overlayState,
    get sendCount() { return sendCount; },
    get issues() { return issues.slice(); },
    fireStorage(changes) {
      assert(storageListener, "storage listener should be installed");
      storageListener(changes, "local");
    },
    fireRuntime(message) {
      assert(runtimeListener, "runtime listener should be installed");
      return runtimeListener(message, {}, () => {});
    },
    navigate(id) {
      context.location.pathname = `/c/${id}`;
      context.location.href = `https://chatgpt.com/c/${id}`;
    }
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  {
    let url = "https://chatgpt.com/c/a";
    const sandbox = { module: { exports: {} } };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(SCOPE, sandbox, { filename: "conversation-scope.js" });
    const scope = sandbox.CGConversationScope.create({ getId: () => conversationIdFromUrl(url) });
    const a = scope.snapshot();
    assert.equal(a.id, "a");
    url = "https://chatgpt.com/c/b";
    assert.equal(scope.isCurrent(a), false, "a token must become stale after navigation");
    assert.equal(scope.snapshot().id, "b");
  }

  const chromium = makeHarness();
  await settle();
  assert.equal(chromium.sendCount, 1, "initial Chrome history fallback should make one background request");

  for (let index = 0; index < 1000; index++) {
    chromium.fireStorage({ cgLastIssue: { newValue: { code: "runtime-request-failed", index } } });
  }
  await settle();
  assert.equal(chromium.sendCount, 1, "diagnostic storage writes must never retrigger history lookup");

  chromium.fireStorage({ maxDisplayMessages: { newValue: 32 } });
  chromium.fireStorage({ mode: { newValue: "windowed-visible" } });
  await settle();
  assert.equal(chromium.sendCount, 2, "overlapping history setting changes should collapse to one retry");

  const firefox = makeHarness({
    packageTarget: "firefox",
    runtimeBrowser: "firefox",
    historyReply: {
      ok: true,
      conversationId: "test-conversation",
      messages: [],
      nativeVisibleCount: 0,
      pageSize: 64,
      maxRendered: 192,
      source: "firefox-network-filter"
    }
  });
  await settle();
  assert.equal(firefox.sendCount, 1, "Firefox package must continue using the Firefox background-history path");
  assert.deepEqual(
    { packageTarget: firefox.context.CGAntiCurseHistoryDebug.debug().packageTarget, runtimeBrowser: firefox.context.CGAntiCurseHistoryDebug.debug().runtimeBrowser },
    { packageTarget: "firefox", runtimeBrowser: "firefox" },
    "Firefox package/runtime diagnostics must stay distinct and correct"
  );

  firefox.fireRuntime({
    type: "cg-window-history",
    history: {
      ok: true,
      conversationId: "different-conversation",
      messages: [{ id: "wrong", role: "user", text: "wrong chat" }],
      nativeVisibleCount: 1,
      pageSize: 64,
      maxRendered: 192,
      source: "firefox-network-filter"
    }
  });
  assert.equal(firefox.context.CGAntiCurseHistoryDebug.debug().historyConversationId, "test-conversation");

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

  const pending = [];
  const routed = makeHarness({
    historyResponder(message) {
      return new Promise((resolve) => pending.push({ message, resolve }));
    }
  });
  await settle();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].message.conversationId, "test-conversation");

  routed.navigate("second-conversation");
  routed.fireStorage({ maxDisplayMessages: { newValue: 48 } });
  await settle();
  assert.equal(pending.length, 2, "navigation should create a new scoped request");
  assert.equal(pending[1].message.conversationId, "second-conversation");

  pending[1].resolve({
    ok: true,
    conversationId: "second-conversation",
    messages: [{ id: "b", role: "user", text: "chat B" }],
    nativeVisibleCount: 1,
    pageSize: 48,
    maxRendered: 144,
    source: "test"
  });
  await settle();
  assert.equal(routed.context.CGAntiCurseHistoryDebug.debug().historyConversationId, "second-conversation");

  pending[0].resolve({
    ok: true,
    conversationId: "test-conversation",
    messages: [{ id: "a", role: "user", text: "chat A" }],
    nativeVisibleCount: 1,
    pageSize: 64,
    maxRendered: 192,
    source: "test"
  });
  await settle();
  assert.equal(routed.context.CGAntiCurseHistoryDebug.debug().historyConversationId, "second-conversation", "late chat A must be discarded");
  assert.equal(routed.overlayState.lastHistory.messages[0].text, "chat B", "rendered history must remain chat B");

  console.log("history request feedback/package-runtime/conversation-scope checks: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});