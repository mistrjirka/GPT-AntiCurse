"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const chrome = fs.readFileSync(path.join(ROOT, "chrome", "pro-recovery-guard.js"), "utf8");
const firefox = fs.readFileSync(path.join(ROOT, "firefox", "pro-recovery-guard.js"), "utf8");
const chromeManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "chrome", "manifest.json"), "utf8"));
const firefoxManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "firefox", "manifest.json"), "utf8"));

assert.equal(chrome, firefox, "Pro recovery guard must remain byte-identical across browsers");
assert(chrome.includes('slug.endsWith("-pro")'));
assert(chrome.includes("function requestModelSlugForTurn"));
assert(chrome.includes("previousElementSibling"), "request lookup must remain adjacent, not historical search");
assert(chrome.includes("selected_display_title"));
assert(chrome.includes('form[data-type="unified-composer"] button.__composer-pill'), "current composer pill must be a model-detection candidate");
assert(chrome.includes("composerModelLabelCandidates"));
assert(chrome.includes('lane:"(instant|thinking|pro)"'));
assert(chrome.includes('selectedModelLane === "pro"'));
assert(chrome.includes('selectedModelLane === "instant" || selectedModelLane === "thinking"'));
assert(chrome.includes('label === "pro" || label === "pro thinking"'));
assert(chrome.includes('/^model\\s+pro(?:\\s|$)/'), "streaming status Pro detection must stay narrowly structured");
assert(!chrome.includes("\\bpro\\b"), "arbitrary translated prose must never use a generic Pro word match");
assert(chrome.includes('decision = "unknown"'), "missing evidence must fail closed");
assert(chrome.includes('if (!state.autoRecoveryAllowed)'));
assert(chrome.includes("rememberAllowedStop(state)"));
assert(chrome.includes("recoveryNudgeState"));
assert(chrome.includes("armRecoveryNudge"));
assert(chrome.includes("STOP_HANDOFF_WINDOW_MS = 420_000"));
assert(chrome.includes("NUDGE_ARM_WINDOW_MS = 5_000"));
assert(chrome.includes("function completedRecoveryState"), "stopped-after-reload recovery needs exact completed-turn classification");
assert(chrome.includes("function pendingReloadMarker"));
assert(chrome.includes("marker && marker.turnKey"));
assert(chrome.includes("turnKey(active) === marker.turnKey"), "a stale streaming turn must not replace the pending reload target");
assert(chrome.includes("return completedRecoveryState(marker.turnKey)"));
assert(chrome.includes("state.autoRecoveryAllowed && (!expectedTurnKey || state.turnKey === expectedTurnKey)"), "recovery authorization must match the exact expected turn");
assert(chrome.includes("if (state.decision === \"pro\") return state"), "current Pro evidence must win before any handoff/completed-turn fallback");
assert(chrome.includes("if (event.isTrusted)"), "human actions must remain untouched");
assert(chrome.includes('button.getAttribute("data-testid") === "stop-button"'));
assert(chrome.includes("composerContainsOnlyNudge()"));
assert(chrome.includes("event.preventDefault()"));
assert(chrome.includes("event.stopImmediatePropagation()"));
assert(!chrome.includes("setInterval("));
assert(!/(^|[^\w])(eval|Function)\s*\(/.test(chrome));

function createGuardWithCurrentComposerLabel(label) {
  const vm = require("vm");
  const streaming = {};
  const section = {
    getAttribute(name) { return name === "data-turn-id" ? "turn-current" : null; }
  };
  const turn = {
    parentElement: null,
    previousElementSibling: null,
    matches() { return false; },
    getAttribute(name) { return name === "data-turn-id-container" ? "turn-current" : null; },
    querySelector(selector) {
      if (selector === '[data-streaming-response-status]') return streaming;
      if (selector === '[data-testid^="conversation-turn-"]') return section;
      if (selector.includes('[data-message-author-role="assistant"]') || selector.includes('[data-turn="assistant"]')) return section;
      return null;
    },
    querySelectorAll() { return []; }
  };
  const pill = {
    textContent: label,
    getAttribute(name) { return name === "aria-label" ? label : null; }
  };
  const context = {
    console,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    Element: class Element {},
    document: {
      scripts: [],
      querySelectorAll(selector) {
        if (selector === '[data-turn-id-container]') return [turn];
        if (selector.includes('button.__composer-pill')) return [pill];
        return [];
      },
      querySelector() { return null; },
      addEventListener() {}
    },
    window: { dispatchEvent() {} }
  };
  context.globalThis = context;
  vm.runInNewContext(chrome, context, { filename: "pro-recovery-guard.js" });
  return {
    context,
    pill,
    debug() { return context.CGAntiCurseProRecoveryGuard.debug(); }
  };
}

function executeGuardWithCurrentComposerLabel(label) {
  return createGuardWithCurrentComposerLabel(label).debug();
}

{
  const currentThinking = executeGuardWithCurrentComposerLabel("Extra High");
  assert.equal(currentThinking.recoveryDecision, "non-pro", "current Extra High composer pill must authorize Auto-Continue without a message model slug");
  assert.equal(currentThinking.detectionSource, "composer-model-label");
  const currentPro = executeGuardWithCurrentComposerLabel("Pro");
  assert.equal(currentPro.recoveryDecision, "pro", "current Pro composer pill must remain hard-blocked");
  assert.equal(currentPro.autoRecoveryAllowed, false);

  const delayed = createGuardWithCurrentComposerLabel("");
  assert.equal(delayed.debug().recoveryDecision, "unknown", "missing composer model evidence must fail closed while hydration is incomplete");
  delayed.pill.textContent = "Extra High";
  assert.equal(delayed.debug().recoveryDecision, "non-pro", "late non-Pro model hydration must become recoverable without a reload");
  delayed.pill.textContent = "Pro";
  const delayedPro = delayed.debug();
  assert.equal(delayedPro.recoveryDecision, "pro", "late Pro hydration must immediately become blocked");
  assert.equal(delayedPro.autoRecoveryAllowed, false);
}

for (const [browser, manifest] of [["chrome", chromeManifest], ["firefox", firefoxManifest]]) {
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
  const reloadState = scripts.indexOf("recovery-reload-state.js");
  const guard = scripts.indexOf("pro-recovery-guard.js");
  const recovery = scripts.indexOf("stall-recovery.js");
  assert(reloadState >= 0 && reloadState < guard, `${browser}: reload marker must exist before the Pro guard`);
  assert(guard >= 0 && guard < recovery, `${browser}: Pro guard must install before stall recovery`);
}

console.log("Pro exclusion and exact-turn reload recovery safety: PASS");
