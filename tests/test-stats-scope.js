"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const scopeSource = fs.readFileSync(path.join(ROOT, "chrome", "conversation-scope.js"), "utf8");
const chromeContent = fs.readFileSync(path.join(ROOT, "chrome", "content.js"), "utf8");
const firefoxContent = fs.readFileSync(path.join(ROOT, "firefox", "content.js"), "utf8");

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function baseContext() {
  const windowListeners = new Map();
  const runtimeListeners = [];
  const dispatched = [];
  const context = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    location: {
      origin: "https://chatgpt.com",
      href: "https://chatgpt.com/c/b",
      pathname: "/c/b"
    },
    navigator: { userAgent: "test" },
    CustomEvent: class {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    },
    document: {
      body: null,
      documentElement: {
        contains() { return false; },
        appendChild() {}
      },
      createElement() {
        return {
          dataset: {},
          classList: { add() {}, remove() {} },
          remove() {},
          set id(_value) {},
          set title(_value) {},
          set textContent(_value) {},
          set innerHTML(_value) {}
        };
      }
    },
    window: {
      addEventListener(type, listener) { windowListeners.set(type, listener); },
      postMessage() {},
      dispatchEvent(event) { dispatched.push(event); }
    },
    CGAntiCurseDiagnostics: {
      record() { return Promise.resolve(null); },
      clear() { return Promise.resolve(true); }
    },
    __windowListeners: windowListeners,
    __runtimeListeners: runtimeListeners,
    __dispatched: dispatched
  };
  context.globalThis = context;
  return context;
}

async function testChromiumRejectsStaleStats() {
  const context = baseContext();
  let runtimeListener = null;
  context.chrome = {
    storage: {
      local: { get() { return Promise.resolve({ showGuardNotice: false, cgLastIssue: null }); } },
      onChanged: { addListener() {} }
    },
    runtime: {
      sendMessage() { return Promise.resolve({}); },
      onMessage: { addListener(listener) { runtimeListener = listener; } }
    }
  };

  vm.runInNewContext(scopeSource, context, { filename: "conversation-scope.js" });
  vm.runInNewContext(chromeContent, context, { filename: "chrome/content.js" });
  await tick();

  const onMessage = context.__windowListeners.get("message");
  assert(onMessage, "Chromium content bridge should listen for MAIN-world messages");

  onMessage({
    source: context.window,
    origin: context.location.origin,
    data: { channel: "__gpt_anticurse_v1__", type: "stats", stats: { mode: "trimmed", conversationId: "a" } }
  });

  let reply = Symbol("unset");
  runtimeListener({ type: "cg-get-stats" }, {}, (value) => { reply = value; });
  assert.equal(reply, null, "late chat A stats must not become the current chat B status");
  assert.equal(context.__dispatched.length, 0, "stale stats must not trigger the history watchdog event");

  onMessage({
    source: context.window,
    origin: context.location.origin,
    data: { channel: "__gpt_anticurse_v1__", type: "stats", stats: { mode: "trimmed", conversationId: "b" } }
  });
  runtimeListener({ type: "cg-get-stats" }, {}, (value) => { reply = value; });
  assert.equal(reply.conversationId, "b");
  assert.equal(context.__dispatched.at(-1).detail.conversationId, "b");
}

async function testFirefoxRejectsStaleStats() {
  const context = baseContext();
  let pushedStatsListener = null;
  context.browser = {
    storage: {
      local: { get() { return Promise.resolve({ showGuardNotice: false, cgLastIssue: null }); } },
      onChanged: { addListener() {} }
    },
    runtime: {
      sendMessage(message) {
        assert.equal(message.type, "cg-get-stats");
        assert.equal(message.conversationId, "b", "initial Firefox stats lookup must request the active conversation");
        return Promise.resolve(null);
      },
      onMessage: { addListener(listener) { pushedStatsListener = listener; } }
    }
  };

  vm.runInNewContext(scopeSource, context, { filename: "conversation-scope.js" });
  vm.runInNewContext(firefoxContent, context, { filename: "firefox/content.js" });
  await tick();

  assert(pushedStatsListener, "Firefox content script should register its pushed-stats listener");
  pushedStatsListener({ type: "cg-stats", stats: { mode: "trimmed", conversationId: "a" } });
  assert.equal(context.__dispatched.length, 0, "late chat A stats must be ignored on chat B");

  pushedStatsListener({ type: "cg-stats", stats: { mode: "trimmed", conversationId: "b" } });
  assert.equal(context.__dispatched.length, 1);
  assert.equal(context.__dispatched[0].detail.conversationId, "b");
}

(async () => {
  await testChromiumRejectsStaleStats();
  await testFirefoxRejectsStaleStats();
  console.log("conversation-scoped stats tests: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
