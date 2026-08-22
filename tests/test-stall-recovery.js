"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const chromeSource = fs.readFileSync(path.join(ROOT, "chrome", "stall-recovery.js"), "utf8");
const firefoxSource = fs.readFileSync(path.join(ROOT, "firefox", "stall-recovery.js"), "utf8");
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
assert(chromeSource.includes('!== "IS_STREAMING"'), "ordinary recovery must require exact backend streaming status");
assert.equal((chromeSource.match(/streamStatus\(id\)/g) || []).length >= 2, true, "ordinary recovery must confirm stream status twice");
assert(chromeSource.includes("function hasLongWaitBanner"), "explicit ChatGPT long-wait UI must be recognized as a stall signal");
assert(chromeSource.includes("our systems are thinking a bit more about this request"));
assert(chromeSource.includes("help.openai.com/articles/20001326"));
assert(chromeSource.includes("if (!longWaitBanner && await streamStatus(id)"), "banner must OR with, not depend on, backend stall confirmation");
assert(chromeSource.includes("hasLongWaitBanner(activeTurn) ? 0"), "banner must schedule an immediate recovery check");
assert(chromeSource.includes("document.visibilityState !== \"visible\""));
assert(chromeSource.includes("hasUserDraft()"));
assert(chromeSource.includes("attemptedTurnKey"));
assert(chromeSource.includes("sessionStorage.setItem"));
assert(chromeSource.includes("location.reload()"));
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
}

for (const [browser, manifest, popup] of [["chrome", chromeManifest, chromePopup], ["firefox", firefoxManifest, firefoxPopup]]) {
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
  assert(scripts.includes("session-auth.js"), `${browser}: shared auth helper must be packaged`);
  assert(scripts.includes("stall-recovery.js"), `${browser}: watchdog must be a normal packaged content script`);
  assert(popup.includes('id="stallRecovery"'), `${browser}: auto-recovery toggle must be visible in the popup`);
}

assert(css.includes("html.cg-anticurse-performance .loading-shimmer-tertiary"));
assert(css.includes("animation: none !important"), "performance mode should disable the non-composited loading shimmer");
assert(!/html\.cg-anticurse-performance[^}]*working-dot|html\.cg-anticurse-performance[^}]*spin/s.test(css), "compositor transform animations must remain untouched");

console.log("stall recovery and profile-backed UI optimization regression tests: PASS");
