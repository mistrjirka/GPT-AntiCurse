"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const chromeSource = fs.readFileSync(path.join(ROOT, "chrome", "stall-recovery.js"), "utf8");
const firefoxSource = fs.readFileSync(path.join(ROOT, "firefox", "stall-recovery.js"), "utf8");
const chromeInput = fs.readFileSync(path.join(ROOT, "chrome", "composer-native-input.js"), "utf8");
const firefoxInput = fs.readFileSync(path.join(ROOT, "firefox", "composer-native-input.js"), "utf8");
const chromeReload = fs.readFileSync(path.join(ROOT, "chrome", "recovery-reload-state.js"), "utf8");
const firefoxReload = fs.readFileSync(path.join(ROOT, "firefox", "recovery-reload-state.js"), "utf8");
const statusUi = fs.readFileSync(path.join(ROOT, "chrome", "recovery-status-ui.js"), "utf8");
const firefoxStatusUi = fs.readFileSync(path.join(ROOT, "firefox", "recovery-status-ui.js"), "utf8");
const chromeManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "chrome", "manifest.json"), "utf8"));
const firefoxManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "firefox", "manifest.json"), "utf8"));

assert.equal(chromeSource, firefoxSource, "recovery controller must stay byte-identical");
assert.equal(chromeInput, firefoxInput, "composer input helper must stay byte-identical");
assert.equal(chromeReload, firefoxReload, "reload state helper must stay byte-identical");
assert.equal(statusUi, firefoxStatusUi, "recovery status UI must stay byte-identical");

assert(chromeSource.includes("const STALL_TIMEOUT_MS = 120_000;"));
assert(chromeSource.includes("const PHASE_TIMEOUT_MS = 120_000;"), "loading, Stop settlement and Send readiness must share the fixed two-minute ceiling");
assert(!chromeSource.includes("300_000"));
assert(!chromeSource.includes("stallRecoveryToolTimeoutSeconds"));
assert(!chromeSource.includes("stallRecoveryGraceSeconds"));
assert(!chromeSource.includes("runningTool("));
assert(!chromeSource.includes("requestAnimationFrame("), "hidden-tab recovery must not depend on rAF");
assert(!chromeSource.includes("setInterval("), "recovery remains deadline/event driven");
assert(chromeSource.includes("queueMicrotask("));
assert(chromeSource.includes("function newestAssistantTurn"));
assert(chromeSource.includes("function newestAssistantStreaming"));
assert(chromeSource.includes("return !stopButton() && !newestAssistantStreaming() && composerIdle();"), "stale historical streaming markers must not hold Stop open");
assert(chromeSource.includes("const status = await streamStatus(id);"), "DOM Stop settlement must be confirmed by backend state");
assert(chromeSource.includes("status !== null && status !== \"IS_STREAMING\""));
assert(chromeSource.includes("function restoreReloadTransaction"));
assert(chromeSource.includes("guardedReload(\"loading-timeout\""), "pre-output/shell loading must reload after two minutes");
assert(chromeSource.includes("guardedReload(\"stop-timeout\""), "stuck Stop cancellation must use the one guarded reload");
assert(chromeSource.includes("guardedReload(\"send-readiness-timeout\""), "stuck Send readiness must use the one guarded reload");
assert(chromeSource.includes("performStopAndResume({ id: marker.conversationId, key, allowReload: false })"), "post-reload running state must Stop once more without another reload");
assert(chromeSource.includes("const sent = await sendNudge(marker.turnKey)"), "post-reload stopped state must resume directly");
assert(chromeSource.includes("attemptedTurns"));
assert(chromeSource.includes("lastRecoveryFailure"));
assert(chromeSource.includes("transitions: transitionLog.slice()"));
assert(chromeSource.includes("COMPOSER_INPUT.insertNudge"));
assert(chromeSource.includes("COMPOSER_INPUT.clearNudge"));
assert(chromeSource.includes("armNudge(originalKey)"));
assert(chromeSource.includes("blockedClickCount"));
assert(chromeSource.includes("modelState().decision === \"pro\""));
assert(chromeSource.includes("if (state.autoRecoveryAllowed !== true)"), "unknown and Pro states must fail closed");
assert(chromeSource.includes("if (hasUserDraft())"));

assert(chromeInput.includes('document.execCommand("insertText"'), "controlled editor input must prefer the browser editing path");
assert(chromeInput.includes("input-event-fallback"), "DOM/InputEvent fallback remains available for compatible editors");
assert(chromeInput.includes("function clearNudge"), "rollback must use the editor-aware helper too");
assert(!chromeInput.includes("innerHTML"));

assert(chromeReload.includes("const MAX_RELOADS = 1;"), "one recovery transaction may reload at most once");
assert(chromeReload.includes("reload-already-used"));
assert(chromeReload.includes("sessionStorage.setItem"));
assert(chromeReload.includes("sessionStorage.removeItem"));

for (const expected of ['return "Pro off"', 'return "model ?"', 'return "stopping"', 'return "sending"', 'return "sent…"', 'return "reload"', 'return "resume"']) {
  assert(statusUi.includes(expected), `compact recovery UI missing ${expected}`);
}
assert(statusUi.includes("load ${countdown(value.remainingMs)}"));

for (const [browser, manifest] of [["chrome", chromeManifest], ["firefox", firefoxManifest]]) {
  assert.equal(manifest.version, "0.7.6", `${browser} manifest must identify the 0.7.6 candidate`);
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
  for (const file of ["composer-native-input.js", "recovery-reload-state.js", "pro-recovery-guard.js", "stall-recovery.js"]) {
    assert(scripts.includes(file), `${browser}: missing ${file}`);
  }
  assert(scripts.indexOf("composer-native-input.js") < scripts.indexOf("stall-recovery.js"));
  assert(scripts.indexOf("recovery-reload-state.js") < scripts.indexOf("stall-recovery.js"));
  assert(scripts.indexOf("pro-recovery-guard.js") < scripts.indexOf("stall-recovery.js"));
}

console.log("stall recovery 0.7.6 transaction/reload regression tests: PASS");
