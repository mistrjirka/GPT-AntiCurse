"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const scopeSource = fs.readFileSync(path.join(ROOT, "chrome", "conversation-scope.js"), "utf8");
const chromeContent = fs.readFileSync(path.join(ROOT, "chrome", "content.js"), "utf8");
const firefoxContent = fs.readFileSync(path.join(ROOT, "firefox", "content.js"), "utf8");
const STATUS_ID = "cg-conversation-guard-status";

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { for (const name of names) this.values.add(name); }
  remove(...names) { for (const name of names) this.values.delete(name); }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(tagName, notifyMutation) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.nodeType = 1;
    this.id = "";
    this.title = "";
    this.textContent = "";
    this.className = "";
    this.dataset = {};
    this.classList = new FakeClassList();
    this.children = [];
    this.parentElement = null;
    this._notifyMutation = notifyMutation;
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    this._notifyMutation(this, [child]);
    return child;
  }
  append(...children) { for (const child of children) this.appendChild(child); }
  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    for (const child of children) this.appendChild(child);
  }
  remove() {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    parent.children = parent.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  contains(target) {
    if (target === this) return true;
    return this.children.some((child) => child.contains && child.contains(target));
  }
}

function baseContext({ showGuardNotice = false } = {}) {
  const windowListeners = new Map();
  const dispatched = [];
  const observers = new Set();

  function notifyMutation(target, addedNodes) {
    for (const observer of observers) {
      if (!observer.active || observer.target !== target || !observer.options.childList) continue;
      observer.callback([{ target, addedNodes }]);
    }
  }

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.active = false;
      this.target = null;
      this.options = null;
      observers.add(this);
    }
    observe(target, options) {
      this.target = target;
      this.options = options || {};
      this.active = true;
    }
    disconnect() { this.active = false; }
  }

  const body = new FakeElement("body", notifyMutation);
  const documentElement = new FakeElement("html", notifyMutation);
  documentElement.appendChild(body);
  const document = {
    body,
    documentElement,
    createElement(tagName) { return new FakeElement(tagName, notifyMutation); },
    querySelectorAll(selector) {
      if (selector !== `[id="${STATUS_ID}"]`) return [];
      const result = [];
      const visit = (element) => {
        if (element.id === STATUS_ID) result.push(element);
        for (const child of element.children || []) visit(child);
      };
      visit(documentElement);
      return result;
    }
  };

  const context = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    Node: { ELEMENT_NODE: 1 },
    MutationObserver: FakeMutationObserver,
    location: {
      origin: "https://chatgpt.com",
      href: "https://chatgpt.com/c/b",
      pathname: "/c/b"
    },
    navigator: { userAgent: "test" },
    CustomEvent: class {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    },
    document,
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
    __dispatched: dispatched,
    __showGuardNotice: showGuardNotice
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
  assert.equal(context.__dispatched.length, 0, "an empty initial stats response must not publish a watchdog event");
  pushedStatsListener({ type: "cg-stats", stats: { mode: "trimmed", conversationId: "a" } });
  assert.equal(context.__dispatched.length, 0, "late chat A stats must be ignored on chat B");

  pushedStatsListener({ type: "cg-stats", stats: { mode: "trimmed", conversationId: "b" } });
  assert.equal(context.__dispatched.length, 1);
  assert.equal(context.__dispatched[0].detail.conversationId, "b");
}

async function testStatusBadgeIsDomSingleton() {
  const context = baseContext({ showGuardNotice: true });
  let runtimeListener = null;
  const existingA = context.document.createElement("div");
  existingA.id = STATUS_ID;
  const existingB = context.document.createElement("div");
  existingB.id = STATUS_ID;
  context.document.body.append(existingA, existingB);

  context.chrome = {
    storage: {
      local: { get() { return Promise.resolve({ showGuardNotice: true, cgLastIssue: null }); } },
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
  onMessage({
    source: context.window,
    origin: context.location.origin,
    data: {
      channel: "__gpt_anticurse_v1__",
      type: "stats",
      stats: {
        mode: "trimmed",
        conversationId: "b",
        mappingNodesBefore: 100,
        mappingNodesAfter: 20,
        displayAfter: 12,
        logicalDisplayAfter: 8,
        originalBytes: 8 * 1024 * 1024,
        outputBytes: 2 * 1024 * 1024,
        processingMs: 4
      }
    }
  });

  assert.equal(context.document.querySelectorAll(`[id="${STATUS_ID}"]`).length, 1, "existing duplicate status pills must collapse to one");

  const lateDuplicate = context.document.createElement("div");
  lateDuplicate.id = STATUS_ID;
  context.document.body.appendChild(lateDuplicate);
  assert.equal(context.document.querySelectorAll(`[id="${STATUS_ID}"]`).length, 1, "a later stale content-script badge must be removed by the DOM singleton observer");

  let reply = null;
  runtimeListener({ type: "cg-get-stats" }, {}, (value) => { reply = value; });
  assert.equal(reply.conversationId, "b");
}

(async () => {
  await testChromiumRejectsStaleStats();
  await testFirefoxRejectsStaleStats();
  await testStatusBadgeIsDomSingleton();
  console.log("conversation-scoped stats/status DOM tests: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
