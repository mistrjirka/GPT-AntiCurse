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
const chromePolicy = fs.readFileSync(path.join(ROOT, "chrome", "recovery-policy.js"), "utf8");
const firefoxPolicy = fs.readFileSync(path.join(ROOT, "firefox", "recovery-policy.js"), "utf8");
const chromeContent = fs.readFileSync(path.join(ROOT, "chrome", "content.js"), "utf8");
const firefoxContent = fs.readFileSync(path.join(ROOT, "firefox", "content.js"), "utf8");
const chromeManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "chrome", "manifest.json"), "utf8"));
const firefoxManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "firefox", "manifest.json"), "utf8"));

// Cross-browser copies are intentional. If behavior differs, it should differ in
// browser adapters, not by silently forking Auto-Continue state-machine code.
assert.equal(chromeSource, firefoxSource, "recovery controller must stay byte-identical");
assert.equal(chromeInput, firefoxInput, "composer input helper must stay byte-identical");
assert.equal(chromeReload, firefoxReload, "reload state helper must stay byte-identical");
assert.equal(statusUi, firefoxStatusUi, "recovery presentation policy must stay byte-identical");
assert.equal(chromePolicy, firefoxPolicy, "recovery state policy must stay byte-identical");

// Architectural invariants only. Runtime behavior belongs in test-recovery-contract.js.
assert(chromeSource.includes("function runRecoveryTransaction"), "all recovery triggers must converge on one transaction");
assert(chromeSource.includes("function settleRunForContinuation"));
assert(chromeSource.includes("function resumeSettledRun"));
assert(chromeSource.includes("async function recoverySafety"), "model safety/hydration policy must be centralized");
assert(chromeSource.includes('longWait ? "long-wait-banner" : "stall-timeout"'), "long-wait banner must be a trigger reason, not a separate recovery algorithm");
assert(chromeSource.includes("const STREAM_STATUS_TIMEOUT_MS = 5_000;"), "backend status checks must be bounded");
assert(chromeSource.includes("const UNKNOWN_MODEL_RECHECK_MS = 500;"), "temporary unknown model state must have an explicit recheck path");
assert(chromeSource.includes('state.decision === "unknown") countdownUiTimer = setTimeout(syncMonitoring, UNKNOWN_MODEL_RECHECK_MS)'), "waiting-for-model must not depend on unrelated DOM churn");
assert(chromeSource.includes("Promise.race([request, timedOut])"), "backend status checks must not block a recovery transaction indefinitely");
assert(chromeSource.includes('status !== null && status !== "IS_STREAMING"'), "only a definitive non-streaming backend state may veto recovery");
assert(chromeSource.includes('status === null) triggerReason = "stall-timeout-status-unknown"'), "status lookup failure must not be mistaken for a settled run");
assert(chromeSource.includes('preOutputLoading(activeTurn) ? "pre-output-timeout" : "shell-loading-timeout"'), "loading stalls must also enter the shared recovery transaction");
assert(!chromeSource.includes('guardedReload("loading-timeout"'), "loading timeout must not bypass the shared recovery transaction");
assert(chromeSource.includes("RECOVERY_POLICY?.settlement?."), "settlement must use the directly tested recovery policy");
assert(chromeSource.includes("RECOVERY_POLICY?.recoveryVisible?."), "badge visibility must use the directly tested recovery policy");
assert(chromeSource.includes("RECOVERY_POLICY?.terminalEmpty?."), "terminal no-answer detection must use the directly tested recovery policy");
assert(chromeSource.includes('reason === "empty-completion"'), "terminal no-answer recovery must enter the shared transaction, not a second implementation");
assert(chromeSource.includes("observedRunningTurns"), "terminal retries must only apply to turns AntiCurse actually observed running");
assert(chromeSource.includes("EMPTY_COMPLETION_RETRY_LIMIT = 3"), "terminal no-answer retries must be bounded");
assert(chromeSource.includes("const ok = await runRecoveryTransaction({"), "reload must resume the shared transaction");
assert(!chromeSource.includes("performStopAndResume"), "do not reintroduce a second stop/resume implementation");
assert(chromeSource.includes("function mutationIsOnlyOwnStatusUi"), "watchdog must ignore its own status-badge mutations");
assert(chromeSource.includes("characterData: true"), "model hydration waits must wake on text-node updates");
assert(!chromeSource.includes("setInterval("), "recovery must remain event/timer driven, not polling-loop driven");

// The controlled editor helper must use editor-compatible events and support rollback.
assert(chromeInput.includes('document.execCommand("insertText"'));
assert(chromeInput.includes("input-event-fallback"));
assert(chromeInput.includes("function clearNudge"));
assert(!chromeInput.includes("innerHTML"));

// Reload is a bounded transport fallback, never an independent recovery loop.
assert(chromeReload.includes("const MAX_RELOADS = 1;"));
assert(chromeReload.includes("reload-already-used"));
assert(chromeReload.includes("sessionStorage.setItem"));

// Status presentation is pure. content.js is the only DOM owner for the badge.
assert(!statusUi.includes("addEventListener"));
assert(!statusUi.includes("MutationObserver"));
assert(chromeContent.includes("function renderRecoveryBadge"));
assert(firefoxContent.includes("function renderRecoveryBadge"));
assert(chromeContent.includes("GPT AntiCurse — ${view.title}"));

for (const [browser, manifest] of [["chrome", chromeManifest], ["firefox", firefoxManifest]]) {
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
  for (const file of ["composer-native-input.js", "recovery-reload-state.js", "pro-recovery-guard.js", "recovery-policy.js", "stall-recovery.js"]) {
    assert(scripts.includes(file), `${browser}: missing ${file}`);
  }
  assert(scripts.indexOf("composer-native-input.js") < scripts.indexOf("stall-recovery.js"));
  assert(scripts.indexOf("recovery-reload-state.js") < scripts.indexOf("stall-recovery.js"));
  assert(scripts.indexOf("pro-recovery-guard.js") < scripts.indexOf("stall-recovery.js"));
  assert(scripts.indexOf("recovery-policy.js") < scripts.indexOf("stall-recovery.js"));
}

console.log("Auto-Continue architecture invariants: PASS");
