"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ff = (name) => fs.readFileSync(path.join(ROOT, "firefox", name), "utf8");
const chrome = (name) => fs.readFileSync(path.join(ROOT, "chrome", name), "utf8");
const ffManifest = JSON.parse(ff("manifest.json"));
const chromeManifest = JSON.parse(chrome("manifest.json"));
const recovery = ff("stall-recovery.js");
const guard = ff("pro-recovery-guard.js");
const input = ff("composer-native-input.js");
const reload = ff("recovery-reload-state.js");
const statusUi = ff("recovery-status-ui.js");
const debugState = ff("debug-state.js");

assert.equal(ffManifest.version, "0.7.6");
assert.equal(chromeManifest.version, "0.7.6");
for (const name of ["stall-recovery.js", "pro-recovery-guard.js", "composer-native-input.js", "recovery-reload-state.js", "recovery-status-ui.js", "debug-state.js"]) {
  assert.equal(ff(name), chrome(name), `${name} must remain byte-identical across browser packages`);
}

for (const manifest of [ffManifest, chromeManifest]) {
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
  for (const name of ["recovery-reload-state.js", "composer-native-input.js", "pro-recovery-guard.js", "stall-recovery.js"]) {
    assert(scripts.includes(name), `${name} must be packaged`);
  }
  assert(scripts.indexOf("recovery-reload-state.js") < scripts.indexOf("pro-recovery-guard.js"));
  assert(scripts.indexOf("composer-native-input.js") < scripts.indexOf("stall-recovery.js"));
}

assert(recovery.includes("const STALL_TIMEOUT_MS = 120_000;"));
assert(recovery.includes("const RECOVERY_RELOAD_TIMEOUT_MS = 120_000;"), "loading/cancellation fallback must use the same two-minute ceiling");
assert(recovery.includes("const MAX_RECOVERY_RELOADS = 1;"), "recovery may reload at most once");
assert(recovery.includes('"pre-output-loading-timeout"'), "pre-output loading must gain a bounded reload fallback");
assert(recovery.includes('"stop-still-loading"'), "slow cancellation must gain a bounded reload fallback");
assert(recovery.includes("function scheduleRecoveryReload"));
assert(recovery.includes("function resumeRecoveryAfterReload"));
assert(recovery.includes("function classifyReloadRunState"));
assert(recovery.includes('source: "stop-button"'), "post-reload running state must prefer the real Stop control");
assert(recovery.includes('source: "composer-send"'), "post-reload stopped state may use the restored Send control");
assert(recovery.includes("restoreReloadHandoff(marker)"), "a stopped post-reload run must restore only the approved non-Pro handoff");
assert(recovery.includes("stop.click();"), "a still-running post-reload request must be stopped again");

assert(recovery.includes("const STOP_BACKEND_POLL_MS = 1_500;"));
assert(recovery.includes("function latestAssistantShowsStoppedState"));
assert(recovery.includes("function originalTurnStillStreaming"));
assert(recovery.includes("if (!stopPresent) {\n        const status = await streamStatus(id);"), "once Stop disappears, stale streaming DOM must be resolved through backend state");
assert(recovery.includes('lastStopSettlementSource = "backend"'));
assert(recovery.includes('lastStopSettlementSource = "timeout"'));
assert(recovery.includes("Math.min(STOP_SETTLE_TIMEOUT_MS, RECOVERY_RELOAD_TIMEOUT_MS)"));

assert(input.includes('document.execCommand("insertText", false, String(text))'), "continuation insertion must update the controlled editor through an editing command");
assert(input.includes('document.execCommand("delete", false, null)'), "rollback must update the controlled editor too");
assert(recovery.includes('lastNudgeInsertMethod = "native-editor"'));
assert(recovery.includes('lastNudgeStage = "send-not-ready"'));
assert(recovery.includes('"send-not-confirmed"'));
assert(recovery.includes('lastNudgeStage = "insert-reverted"'));

assert(reload.includes('__gpt_anticurse_recovery_reload_v1__'));
assert(reload.includes("TTL_MS = 10 * 60_000"));
assert(reload.includes('value.approval?.decision !== "non-pro"'), "reload state must never authorize an unapproved/Pro recovery");
assert(guard.includes("function restoreRecoveryHandoff"));
assert(guard.includes('snapshot.decision !== "non-pro"'));
assert(guard.includes('state.decision === "pro"'), "current Pro evidence must still win after reload");

assert(statusUi.includes('case "reloading": return "reload"'));
assert(statusUi.includes('`loading ${countdown(value.remainingMs)}`'));
assert(debugState.includes("recoveryReloadState"));
assert(debugState.includes("composerNativeInput"));
assert(recovery.includes("lastNudgeStage"));
assert(recovery.includes("lastStopSettlementSource"));
assert(recovery.includes("lastStopBackendStatus"));

console.log("0.7.6 bounded reload/editor/stale-stop recovery checks: PASS");
