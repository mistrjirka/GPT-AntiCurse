"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const chrome = fs.readFileSync(path.join(ROOT, "chrome", "pro-recovery-guard.js"), "utf8");
const firefox = fs.readFileSync(path.join(ROOT, "firefox", "pro-recovery-guard.js"), "utf8");
const chromeManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "chrome", "manifest.json"), "utf8"));
const firefoxManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "firefox", "manifest.json"), "utf8"));

assert.equal(chrome, firefox, "Pro recovery guard must remain byte-identical across browsers");
assert(chrome.includes('slug.endsWith("-pro")'), "all explicit *-pro model slugs must be excluded");
assert(chrome.includes("if (event.isTrusted) return;"), "human Stop/Send clicks must never be blocked");
assert(chrome.includes('button.getAttribute("data-testid") === "stop-button"'));
assert(chrome.includes("composerContainsOnlyNudge()"), "fixed AntiCurse nudge must be blocked as defense in depth");
assert(chrome.includes("event.preventDefault()"));
assert(chrome.includes("event.stopImmediatePropagation()"));
assert(chrome.includes("CGAntiCurseProRecoveryGuard"), "guard state should remain locally debuggable");
assert(!chrome.includes("setInterval("), "guard must remain event-driven");
assert(!/(^|[^\w])(eval|Function)\s*\(/.test(chrome));

for (const [browser, manifest] of [["chrome", chromeManifest], ["firefox", firefoxManifest]]) {
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
  const guard = scripts.indexOf("pro-recovery-guard.js");
  const recovery = scripts.indexOf("stall-recovery.js");
  assert(guard >= 0, `${browser}: Pro recovery guard must be packaged`);
  assert(recovery >= 0, `${browser}: stall recovery must remain packaged`);
  assert(guard < recovery, `${browser}: Pro guard must install before stall recovery`);
}

class FakeElement {
  constructor(attrs = {}) {
    this.attrs = { ...attrs };
    this.children = [];
    this.parent = null;
    this.textContent = attrs.textContent || "";
  }
  append(child) { child.parent = this; this.children.push(child); return child; }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
  matches(selector) {
    if (selector === '[data-message-model-slug]') return this.getAttribute("data-message-model-slug") != null;
    if (selector === '[data-streaming-response-status]') return this.getAttribute("data-streaming-response-status") != null;
    if (selector === '[data-testid^="conversation-turn-"]') return String(this.getAttribute("data-testid") || "").startsWith("conversation-turn-");
    return false;
  }
  querySelectorAll(selector) {
    const result = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    if (selector === '#composer-submit-button' && this.getAttribute("id") === "composer-submit-button") return this;
    return this.parent ? this.parent.closest(selector) : null;
  }
}

function runCase(modelSlug, trusted) {
  let clickListener = null;
  const turn = new FakeElement({ "data-turn-id-container": "turn-1" });
  const section = turn.append(new FakeElement({ "data-testid": "conversation-turn-1", "data-turn-id": "turn-1" }));
  section.append(new FakeElement({ "data-message-model-slug": modelSlug }));
  turn.append(new FakeElement({ "data-streaming-response-status": "streaming" }));
  const stop = new FakeElement({ id: "composer-submit-button", "data-testid": "stop-button" });
  const composer = new FakeElement({ id: "prompt-textarea", textContent: "" });
  const document = {
    querySelectorAll(selector) { return selector === '[data-turn-id-container]' ? [turn] : []; },
    querySelector(selector) { return selector.startsWith('#prompt-textarea') ? composer : null; },
    addEventListener(type, listener) { if (type === "click") clickListener = listener; }
  };
  const window = { dispatched: [], dispatchEvent(event) { this.dispatched.push(event); return true; } };
  class CustomEvent { constructor(type, options) { this.type = type; this.detail = options && options.detail; } }
  const context = { document, window, Element: FakeElement, CustomEvent, console };
  context.globalThis = context;
  vm.runInNewContext(chrome, context, { filename: "pro-recovery-guard.js" });
  assert.equal(typeof clickListener, "function");
  const event = {
    isTrusted: trusted,
    target: stop,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; }
  };
  clickListener(event);
  return { event, debug: context.CGAntiCurseProRecoveryGuard.debug(), dispatched: window.dispatched };
}

let runtime = runCase("gpt-5-6-pro", false);
assert.equal(runtime.event.prevented, true, "synthetic Stop must be blocked for GPT-5.6 Pro");
assert.equal(runtime.event.stopped, true);
assert.equal(runtime.debug.blockedClicks, 1);
assert.equal(runtime.debug.lastBlockedModelSlug, "gpt-5-6-pro");

runtime = runCase("gpt-5-5-pro", false);
assert.equal(runtime.event.prevented, true, "synthetic Stop must be blocked for GPT-5.5 Pro too");

runtime = runCase("gpt-5-6-thinking", false);
assert.equal(runtime.event.prevented, false, "known non-Pro recovery remains available");
assert.equal(runtime.debug.blockedClicks, 0);

runtime = runCase("gpt-5-6-pro", true);
assert.equal(runtime.event.prevented, false, "a real user Stop click on Pro must remain native");
assert.equal(runtime.debug.blockedClicks, 0);

console.log("Pro model auto-recovery exclusion: PASS");
