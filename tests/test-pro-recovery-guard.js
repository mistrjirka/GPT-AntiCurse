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
assert(chrome.includes('label.startsWith("pro thinking")'), "current live Pro thinking status must be recognized");
assert(chrome.includes('decision = "unknown"'), "missing model evidence must remain an explicit state");
assert(chrome.includes('if (stop && !state.autoRecoveryAllowed)'), "synthetic Stop must fail closed unless non-Pro is proven");
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
  hasClass(name) {
    const value = this.attrs.class || [];
    const classes = Array.isArray(value) ? value : String(value).split(/\s+/);
    return classes.includes(name);
  }
  matches(selector) {
    if (selector === '[data-message-model-slug]') return this.getAttribute("data-message-model-slug") != null;
    if (selector === '[data-streaming-response-status]') return this.getAttribute("data-streaming-response-status") != null;
    if (selector === '[data-testid^="conversation-turn-"]') return String(this.getAttribute("data-testid") || "").startsWith("conversation-turn-");
    if (selector === '.loading-shimmer-tertiary') return this.hasClass("loading-shimmer-tertiary");
    return false;
  }
  descendants() {
    const result = [];
    const visit = (node) => {
      for (const child of node.children) {
        result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  querySelectorAll(selector) {
    if (selector === '[data-streaming-response-status] .loading-shimmer-tertiary') {
      const result = [];
      for (const stream of this.descendants().filter((node) => node.matches('[data-streaming-response-status]'))) {
        for (const node of stream.descendants()) if (node.matches('.loading-shimmer-tertiary')) result.push(node);
      }
      return result;
    }
    return this.descendants().filter((node) => node.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    if (selector === '#composer-submit-button' && this.getAttribute("id") === "composer-submit-button") return this;
    return this.parent ? this.parent.closest(selector) : null;
  }
}

function runCase({ modelSlug = null, statusLabel = null, composerLabel = null, trusted = false } = {}) {
  let clickListener = null;
  const turn = new FakeElement({ "data-turn-id-container": "turn-1" });
  const section = turn.append(new FakeElement({ "data-testid": "conversation-turn-1", "data-turn-id": "turn-1" }));
  if (modelSlug) section.append(new FakeElement({ "data-message-model-slug": modelSlug }));
  const stream = turn.append(new FakeElement({ "data-streaming-response-status": "streaming" }));
  if (statusLabel) stream.append(new FakeElement({ class: ["loading-shimmer-tertiary"], textContent: statusLabel }));
  const modelTrigger = composerLabel
    ? new FakeElement({ "data-animated-slider-trigger": "true", textContent: composerLabel })
    : null;
  const stop = new FakeElement({ id: "composer-submit-button", "data-testid": "stop-button" });
  const composer = new FakeElement({ id: "prompt-textarea", textContent: "" });
  const document = {
    querySelectorAll(selector) {
      if (selector === '[data-turn-id-container]') return [turn];
      if (selector === 'button.__composer-pill [data-animated-slider-trigger="true"]') return modelTrigger ? [modelTrigger] : [];
      return [];
    },
    querySelector(selector) { return selector.startsWith('#prompt-textarea') ? composer : null; },
    addEventListener(type, listener) { if (type === "click") clickListener = listener; }
  };
  const window = { dispatched: [], dispatchEvent(event) { this.dispatched.push(event); return true; } };
  class CustomEvent { constructor(type, options) { this.type = type; this.detail = options && options.detail; } }
  const context = { document, window, Element: FakeElement, CustomEvent, console, Set };
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

let runtime = runCase({ modelSlug: "gpt-5-6-pro" });
assert.equal(runtime.event.prevented, true, "synthetic Stop must be blocked for GPT-5.6 Pro slug");
assert.equal(runtime.event.stopped, true);
assert.equal(runtime.debug.recoveryDecision, "pro");
assert.equal(runtime.debug.detectionSource, "message-model-slug");
assert.equal(runtime.debug.blockedClicks, 1);
assert.equal(runtime.debug.lastBlockedModelSlug, "gpt-5-6-pro");

runtime = runCase({ statusLabel: "Pro thinking", composerLabel: "Pro" });
assert.equal(runtime.event.prevented, true, "live 2026-08 Pro DOM must block synthetic Stop without a model slug");
assert.equal(runtime.debug.recoveryDecision, "pro");
assert.equal(runtime.debug.detectionSource, "streaming-pro-status");
assert.equal(runtime.debug.proStatusLabel, "Pro thinking");
assert.equal(runtime.debug.activeModelSlug, null);

runtime = runCase({ composerLabel: "Pro" });
assert.equal(runtime.event.prevented, true, "selected Pro composer mode must block recovery even without status text");
assert.equal(runtime.debug.recoveryDecision, "pro");
assert.equal(runtime.debug.detectionSource, "composer-model-label");

runtime = runCase();
assert.equal(runtime.event.prevented, true, "unknown model identity must fail closed");
assert.equal(runtime.debug.recoveryDecision, "unknown");
assert.equal(runtime.debug.autoRecoveryAllowed, false);
assert.equal(runtime.debug.blockedUnknownClicks, 1);

runtime = runCase({ modelSlug: "gpt-5-6-thinking" });
assert.equal(runtime.event.prevented, false, "explicit non-Pro slug may recover");
assert.equal(runtime.debug.recoveryDecision, "non-pro");
assert.equal(runtime.debug.autoRecoveryAllowed, true);
assert.equal(runtime.debug.blockedClicks, 0);

runtime = runCase({ composerLabel: "Thinking" });
assert.equal(runtime.event.prevented, false, "known Thinking composer mode may recover without a slug");
assert.equal(runtime.debug.recoveryDecision, "non-pro");
assert.equal(runtime.debug.detectionSource, "composer-model-label");

runtime = runCase({ statusLabel: "Pro thinking", composerLabel: "Pro", trusted: true });
assert.equal(runtime.event.prevented, false, "a real user Stop click on Pro must remain native");
assert.equal(runtime.debug.blockedClicks, 0);

console.log("Pro model auto-recovery exclusion, live DOM detection, and fail-closed fallback: PASS");
