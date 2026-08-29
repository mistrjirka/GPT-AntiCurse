"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const chromePolicy = fs.readFileSync(path.join(ROOT, "chrome", "recovery-policy.js"), "utf8");
const firefoxPolicy = fs.readFileSync(path.join(ROOT, "firefox", "recovery-policy.js"), "utf8");
const statusSource = fs.readFileSync(path.join(ROOT, "firefox", "recovery-status-ui.js"), "utf8");

assert.equal(chromePolicy, firefoxPolicy, "recovery policy must stay byte-identical");

const context = { console };
context.globalThis = context;
vm.runInNewContext(chromePolicy, context, { filename: "recovery-policy.js" });
vm.runInNewContext(statusSource, context, { filename: "recovery-status-ui.js" });
const policy = context.CGAntiCurseRecoveryPolicy;
const ui = context.CGAntiCurseRecoveryStatusUi;
assert(policy && ui);

// Real 0.7.7 failure shape from the captured ChatGPT page:
// Stop is already gone, composer is usable, but data-streaming-response-status
// and stream_status may still say streaming for a while.
let result = policy.settlement({
  stopPresent: false,
  composerIdle: true,
  uiSettledMs: 749,
  uiGraceMs: 750
});
assert.equal(result.settled, false, "idle UI must be stable briefly before continuation");

for (const backendStatus of ["IS_STREAMING", "NOT_STREAMING", null]) {
  result = policy.settlement({
    stopPresent: false,
    composerIdle: true,
    backendStatus, // deliberately ignored after Stop: readiness comes from the usable composer
    uiSettledMs: 750,
    uiGraceMs: 750
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { settled: true, source: "ui", uiReady: true });
}

result = policy.settlement({
  stopPresent: false,
  composerIdle: true,
  backendStatus: "NOT_STREAMING",
  uiSettledMs: 0,
  uiGraceMs: 750
});
assert.equal(result.settled, false, "backend state alone must never bypass composer readiness stability");

for (const state of [
  { stopPresent: true, composerIdle: false, uiSettledMs: 5000 },
  { stopPresent: true, composerIdle: true, uiSettledMs: 5000 },
  { stopPresent: false, composerIdle: false, uiSettledMs: 5000 }
]) {
  assert.equal(policy.settlement(state).settled, false, "continuation must not start before the composer is genuinely usable");
}

assert.equal(policy.recoveryVisible({ liveTurnPresent: true }), true);
assert.equal(policy.recoveryVisible({ liveTurnPresent: false }), false);
assert.equal(policy.recoveryVisible({ transactionActive: true }), true);
assert.equal(policy.recoveryVisible({ shellLoading: true }), true);
assert.equal(policy.recoveryVisible({ transactionActive: false, liveTurnPresent: false, shellLoading: false }), false,
  "a quarantined stale turn must not leave an AC 0s zombie indicator");

const phases = new Map([
  ["blocked-pro", "off for Pro"],
  ["blocked-unknown", "waiting for model"],
  ["checking", "checking stall"],
  ["stopping", "stopping"],
  ["settling", "stopped · preparing"],
  ["sending", "continuing"],
  ["confirming", "starting…"],
  ["reloading", "reloading"],
  ["restoring", "resuming"]
]);
for (const [phase, text] of phases) {
  assert.equal(ui.presentation({ active: true, phase }).text, text, `unexpected user-facing status for ${phase}`);
}
assert.equal(ui.presentation({ active: true, phase: "countdown", remainingMs: 0 }).text, "continue now");
assert.equal(ui.presentation({ active: true, phase: "countdown", remainingMs: 61_000 }).text, "continue in 1:01");

console.log("Auto-Continue real-state recovery contracts: PASS");
