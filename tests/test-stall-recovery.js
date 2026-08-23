"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const chromeSource = fs.readFileSync(path.join(ROOT, "chrome", "stall-recovery.js"), "utf8");
const firefoxSource = fs.readFileSync(path.join(ROOT, "firefox", "stall-recovery.js"), "utf8");
const statusUi = fs.readFileSync(path.join(ROOT, "chrome", "recovery-status-ui.js"), "utf8");
const firefoxStatusUi = fs.readFileSync(path.join(ROOT, "firefox", "recovery-status-ui.js"), "utf8");
const chromeManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "chrome", "manifest.json"), "utf8"));
const firefoxManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "firefox", "manifest.json"), "utf8"));
const chromePopup = fs.readFileSync(path.join(ROOT, "chrome", "popup.html"), "utf8");
const firefoxPopup = fs.readFileSync(path.join(ROOT, "firefox", "popup.html"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "chrome", "content.css"), "utf8");

assert.equal(chromeSource, firefoxSource, "watchdog must remain byte-identical across browser packages");
assert(chromeSource.includes("const STALL_TIMEOUT_MS = 120_000;"), "ordinary recovery must use one fixed 120-second stall deadline");
assert(chromeSource.includes("const STOP_SETTLE_TIMEOUT_MS = 180_000;"), "slow ChatGPT Stop settlement must retain a recovery-operation bound");
assert(chromeSource.includes("const SEND_READY_TIMEOUT_MS = 180_000;"), "Send readiness must retain a recovery-operation bound");
assert(chromeSource.includes("const SEND_CONFIRM_TIMEOUT_MS = 30_000;"));
assert(!chromeSource.includes("stallRecoveryToolTimeoutSeconds"), "tool DOM must never switch recovery to a five-minute stall deadline");
assert(!chromeSource.includes("stallRecoveryGraceSeconds"), "the removed post-deadline grace delay must not return");
assert(!chromeSource.includes("function runningTool("), "tool classification must not alter the stall deadline");
assert(chromeSource.includes("return STALL_TIMEOUT_MS;"));
assert(chromeSource.includes('!== "IS_STREAMING"'), "ordinary recovery must require exact backend streaming status");
assert.equal((chromeSource.match(/streamStatus\(id\)/g) || []).length >= 2, true, "ordinary recovery must confirm stream status twice");
assert(chromeSource.includes("function hasLongWaitBanner"), "explicit ChatGPT long-wait UI must remain an immediate stall signal");
assert(chromeSource.includes("our systems are thinking a bit more about this request"));
assert(chromeSource.includes("help.openai.com/articles/20001326"));
assert(chromeSource.includes("if (!longWaitBanner && await streamStatus(id)"), "banner must OR with, not depend on, backend stall confirmation");
assert(chromeSource.includes("hasLongWaitBanner(activeTurn) ? 0"), "banner must schedule an immediate recovery check");
assert(!chromeSource.includes("installVisibilityWakeup"), "visibility must never gate background recovery");
assert(!chromeSource.includes("requestAnimationFrame("), "recovery-critical code must not depend on rAF in hidden tabs");
assert(chromeSource.includes("queueMicrotask("), "background-safe reattachment/nudge dispatch must use microtasks");
assert(chromeSource.includes("recoveringTurns"), "in-flight recovery must be distinct from completed attempts");
assert(chromeSource.includes("if (recoveringTurns.size) return;"), "active recovery must pin the original turn while Stop settles");
assert(chromeSource.includes('setRecoveryPhase("stopping")'));
assert(chromeSource.includes('setRecoveryPhase("sending")'));
assert(chromeSource.includes('setRecoveryPhase("confirming")'));
assert(chromeSource.includes("function waitForStopSettlement"));
assert(chromeSource.includes("!stopButton() && !originalTurnStillStreaming(key)"), "DOM settlement remains one valid fast path");
assert(chromeSource.includes("if (recoveringTurns.size || recoveryPhase) return null;"), "countdown must be suspended for the entire recovery transaction");
assert(chromeSource.includes("lastRecoveryFailure"), "debug telemetry must retain the exact recovery failure stage");
assert(chromeSource.includes("recoveryNudgeModelState(key)"), "post-Stop validation must accept only the guard's same-turn non-Pro handoff");
assert(chromeSource.includes("armRecoveryNudge(originalKey)"), "synthetic Send must arm the approved handoff immediately before click");
assert(chromeSource.includes("recoveryGuardBlockedClicks"), "Send must detect a synchronous Pro/unknown guard block without treating transient post-click unknown as failure");
for (const code of ["stop-not-settled", "transaction-invalidated", "user-draft-during-stop", "model-blocked-after-stop", "nudge-send-failed"]) {
  assert(chromeSource.includes(code), `missing recovery failure telemetry: ${code}`);
}
assert(chromeSource.includes("function clearSyntheticNudge"), "failed recovery must clean up only AntiCurse's synthetic nudge");
assert(chromeSource.includes("composerContainsOnlyNudge()"));
assert(chromeSource.includes("hasUserDraft()"));
assert(chromeSource.includes("attemptedTurnKey"));
assert(!chromeSource.includes("sessionStorage.setItem"), "the watchdog itself should delegate persisted reload state to its dedicated helper");
assert(!chromeSource.includes("location.reload()"), "the watchdog itself should delegate guarded reloads to its dedicated helper");
assert(chromeSource.includes("Insert the nudge first"), "recovery must populate the composer before requiring Send to become enabled");
assert(chromeSource.includes('paragraph.textContent = "."'));
assert(!chromeSource.includes("setInterval("), "watchdog must remain event-driven");
assert(!chromeSource.includes("innerHTML"));
assert(!chromeSource.includes("execCommand"), "editor commands belong in the dedicated composer helper, not the watchdog");
assert(!/(^|[^\w])(eval|Function)\s*\(/.test(chromeSource));
assert(chromeSource.includes('turnListObserver.observe(turnList, { childList: true, subtree: true })'));
assert(chromeSource.includes('activityObserver.observe(activeTurn, {'));
assert(chromeSource.includes('discoveryObserver.observe(root, { childList: true, subtree: true })'));
assert(chromeSource.includes("discoveryTimer = setTimeout(clearDiscovery, 10_000)"));
assert(chromeSource.includes("__gpt_anticurse_stall_status__"));
assert(chromeSource.includes("countdownRemainingMs"));
assert(chromeSource.includes("liveTurnKey"));
assert(chromeSource.includes("function preOutputLoading"));
assert(chromeSource.includes("function shellLoading"));
assert(chromeSource.includes("assistantOutputPresent"));

assert.equal(statusUi, firefoxStatusUi, "compact recovery status adapter must remain byte-identical across browsers");
assert(statusUi.includes("__gpt_anticurse_stall_status__"), "status adapter must listen for recovery state");
for (const expected of ['return "Pro off"', 'return "model ?"', 'return "stopping"', 'return "sending"', 'return "sent…"']) {
  assert(statusUi.includes(expected), `compact status adapter missing ${expected}`);
}
assert(statusUi.includes('case "loading": return Number.isFinite(Number(value.remainingMs)) ? `loading ${countdown(value.remainingMs)}` : "loading";'), "loading state must expose its bounded countdown when available");
assert(statusUi.includes('case "reloading": return "reload";'));
assert(!statusUi.includes("tool auto-continue in"), "status adapter must not restore tool-specific countdowns");

for (const [browser, manifest, popup] of [["chrome", chromeManifest, chromePopup], ["firefox", firefoxManifest, firefoxPopup]]) {
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
  assert(scripts.includes("session-auth.js"), `${browser}: shared auth helper must be packaged`);
  assert(scripts.includes("stall-recovery.js"), `${browser}: watchdog must be packaged`);
  assert(scripts.includes("delivery-timeout-reload.js"), `${browser}: retryable delivery/network errors must be packaged`);
  assert(scripts.includes("recovery-status-ui.js"), `${browser}: compact transaction status adapter must be packaged`);
  assert(scripts.indexOf("delivery-timeout-reload.js") < scripts.indexOf("content.js"), `${browser}: error reload detector should start before content UI`);
  assert(scripts.indexOf("recovery-status-ui.js") < scripts.indexOf("content.js"), `${browser}: transaction status adapter should run before legacy content UI`);
  assert(popup.includes('id="stallRecovery"'), `${browser}: auto-recovery toggle must remain visible`);
  assert(popup.includes("After 2 min without progress"), `${browser}: popup must describe the fixed two-minute deadline`);
  assert(!popup.includes("5 min"), `${browser}: popup must not advertise the removed tool timeout`);
}

assert(css.includes("html.cg-anticurse-performance .loading-shimmer-tertiary"));
assert(css.includes("animation: none !important"));
assert(!/html\.cg-anticurse-performance[^}]*working-dot|html\.cg-anticurse-performance[^}]*spin/s.test(css));

console.log("stall recovery fixed-deadline/transaction regression tests: PASS");
