"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const chromeSource = fs.readFileSync(path.join(ROOT, "chrome", "stall-recovery.js"), "utf8");
const firefoxSource = fs.readFileSync(path.join(ROOT, "firefox", "stall-recovery.js"), "utf8");
const chromeScheduler = fs.readFileSync(path.join(ROOT, "chrome", "stall-scheduler.js"), "utf8");
const firefoxScheduler = fs.readFileSync(path.join(ROOT, "firefox", "stall-scheduler.js"), "utf8");
const chromeContent = fs.readFileSync(path.join(ROOT, "chrome", "content.js"), "utf8");
const firefoxContent = fs.readFileSync(path.join(ROOT, "firefox", "content.js"), "utf8");
const chromeManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "chrome", "manifest.json"), "utf8"));
const firefoxManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "firefox", "manifest.json"), "utf8"));
const chromePopup = fs.readFileSync(path.join(ROOT, "chrome", "popup.html"), "utf8");
const firefoxPopup = fs.readFileSync(path.join(ROOT, "firefox", "popup.html"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "chrome", "content.css"), "utf8");

assert.equal(chromeSource, firefoxSource, "watchdog must remain byte-identical across browser packages");
assert(chromeSource.includes("stallRecoveryTimeoutSeconds: 120"));
assert(chromeSource.includes("stallRecoveryToolTimeoutSeconds: 300"));
assert(chromeSource.includes("stallRecoveryGraceSeconds: 10"));
assert(chromeSource.includes('!== "IS_STREAMING"'), "ordinary recovery must require exact backend streaming status before stopping an active backend run");
assert.equal((chromeSource.match(/streamStatus\(id\)/g) || []).length >= 2, true, "ordinary recovery must confirm stream status twice");
assert(chromeSource.includes("function hasLongWaitBanner"), "explicit ChatGPT long-wait UI must be recognized as a stall signal");
assert(chromeSource.includes("our systems are thinking a bit more about this request"));
assert(chromeSource.includes("help.openai.com/articles/20001326"));
assert(chromeSource.includes("if (!longWaitBanner || !hadStopControl) firstStatus = await streamStatus(id)"), "banner with a visible Stop control may bypass backend polling, while no-Stop fallback must verify backend state");
assert(chromeSource.includes("hasLongWaitBanner(activeTurn) ? 0"), "banner must schedule an immediate recovery check");
assert(!chromeSource.includes('if (document.visibilityState !== "visible")'), "hidden tabs must never pause recovery");
assert(!chromeSource.includes("paused-hidden"), "hidden tabs must remain on the same wall-clock deadline");
assert(chromeSource.includes("watchLatestTurnForStreaming"), "watchdog must close the late streaming-marker race");
assert(chromeSource.includes("onPotentialRunStart"), "long-idle tabs must wake discovery when a run is launched");
assert(chromeSource.includes("queueMicrotask(scheduleDiscovery)"), "run-start wakeup must be lightweight and event-driven");
assert(chromeSource.includes("sameLogicalTurn"), "same logical turn remounts must preserve the deadline");
assert(chromeSource.includes("activeTurn.querySelector(STREAMING_SELECTOR)"), "streaming DOM state, not Stop-button presence, must drive the timer");
assert(chromeSource.includes("/backend-api/stop_conversation"), "missing-Stop recovery must use ChatGPT's current backend stop route");
assert(chromeSource.includes("scheduleBackgroundWakeup"), "content watchdog must arm a background alarm backup");
assert(chromeSource.includes("cg-stall-alarm-fire"), "content watchdog must accept background alarm wakeups");
assert(!chromeSource.includes("requestAnimationFrame("), "stall recovery must not depend on animation frames that stop in background tabs");
assert(chromeSource.includes("hasUserDraft()"));
assert(chromeSource.includes("attemptedTurnKey"));
assert(!chromeSource.includes("sessionStorage.setItem"), "stall recovery must not persist a reload-resume marker");
assert(!chromeSource.includes("location.reload()"), "stall recovery must never reload the page");
assert(chromeSource.includes("Insert the nudge first"), "recovery must populate the composer before requiring Send to become enabled");
assert(chromeSource.includes('paragraph.textContent = "."'));
assert(!chromeSource.includes("setInterval("), "watchdog must be event-driven, never interval-polled");
assert(!chromeSource.includes("innerHTML"));
assert(!chromeSource.includes("execCommand"));
assert(!/(^|[^\w])(eval|Function)\s*\(/.test(chromeSource));
assert(chromeSource.includes('turnListObserver.observe(turnList, { childList: true })'), "steady-state turn-list watch must be direct-child only");
assert(chromeSource.includes('activityObserver.observe(activeTurn, {'), "only the active turn subtree should be observed for progress");
assert(chromeSource.includes('discoveryObserver.observe(root, { childList: true, subtree: true })'), "broad discovery may exist only as temporary fallback");
assert(chromeSource.includes("discoveryTimer = setTimeout(clearDiscovery, 10_000)"), "broad discovery must self-expire");
assert(chromeSource.includes("__gpt_anticurse_stall_status__"), "watchdog must publish live recovery state");
assert(chromeSource.includes("countdownRemainingMs"), "watchdog debug state must expose the live countdown");
for (const [browser, content] of [["chrome", chromeContent], ["firefox", firefoxContent]]) {
  assert(content.includes("__gpt_anticurse_stall_status__"), `${browser}: on-page status must listen for recovery countdowns`);
  assert(content.includes("auto-continue in"), `${browser}: bottom-right status must render the countdown`);
  assert(content.includes("auto-continue resuming"), `${browser}: status must show active recovery phase`);
  assert(!content.includes("paused-hidden"), `${browser}: hidden tabs must not render a paused state`);
}

assert.equal(chromeScheduler, firefoxScheduler, "background stall scheduler must remain byte-identical across browsers");
assert(chromeScheduler.includes("ext.alarms.create"), "background scheduler must use extension alarms");
assert(chromeScheduler.includes("ext.tabs.sendMessage"), "alarm must wake the target content script");

for (const [browser, manifest, popup] of [["chrome", chromeManifest, chromePopup], ["firefox", firefoxManifest, firefoxPopup]]) {
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
  assert(scripts.includes("session-auth.js"), `${browser}: shared auth helper must be packaged`);
  assert(scripts.includes("stall-recovery.js"), `${browser}: watchdog must be a normal packaged content script`);
  assert(manifest.permissions.includes("alarms"), `${browser}: background deadline wakeups require alarms permission`);
  assert(popup.includes('id="stallRecovery"'), `${browser}: auto-recovery toggle must be visible in the popup`);
}

assert(css.includes("html.cg-anticurse-performance .loading-shimmer-tertiary"));
assert(css.includes("animation: none !important"), "performance mode should disable the non-composited loading shimmer");
assert(!/html\.cg-anticurse-performance[^}]*working-dot|html\.cg-anticurse-performance[^}]*spin/s.test(css), "compositor transform animations must remain untouched");

console.log("stall recovery and profile-backed UI optimization regression tests: PASS");
