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
assert(chrome.includes('slug.endsWith("-pro")'), "explicit *-pro slugs must be excluded");
assert(chrome.includes("function requestModelSlugForTurn"), "active request model must be recoverable from the adjacent user turn");
assert(chrome.includes("previousElementSibling"), "request model lookup must stay adjacent rather than searching arbitrary history");
assert(chrome.includes("selected_display_title"), "localized ChatGPT preset labels must resolve through first-party preset metadata");
assert(chrome.includes('lane:"(instant|thinking|pro)"'), "preset parser must accept only canonical intelligence lanes");
assert(chrome.includes('selectedModelLane === "pro"'));
assert(chrome.includes('selectedModelLane === "instant" || selectedModelLane === "thinking"'));
assert(chrome.includes('label === "pro" || label === "pro thinking"'), "streaming Pro detection must remain narrowly structured");
assert(chrome.includes('/^model\\s+pro(?:\\s|$)/'), "structured model Pro status must remain recognized");
assert(chrome.includes("Never treat an arbitrary standalone \"pro\" token as model evidence"), "translated arbitrary status prose must not classify as Pro");
assert(chrome.includes('decision = "unknown"'), "missing model evidence must fail closed");
assert(chrome.includes('if (!state.autoRecoveryAllowed)'), "synthetic actions must fail closed unless non-Pro is proven");
assert(chrome.includes("rememberAllowedStop(state)"), "a proven non-Pro Stop must authorize only its immediate nudge");
assert(chrome.includes("recoveryNudgeState"), "slow Stop must retain only the same-turn approved non-Pro handoff");
assert(chrome.includes("armRecoveryNudge"), "the handoff must be armed only immediately before the synthetic Send");
assert(chrome.includes("STOP_HANDOFF_WINDOW_MS = 420_000"), "the approved Stop handoff must outlive slow ChatGPT cancellation");
assert(chrome.includes("NUDGE_ARM_WINDOW_MS = 5_000"), "actual synthetic Send authorization must remain short-lived");
assert(chrome.includes("if (event.isTrusted)"), "human Stop/Send clicks must never be blocked");
assert(chrome.includes('button.getAttribute("data-testid") === "stop-button"'));
assert(chrome.includes("composerContainsOnlyNudge()"));
assert(chrome.includes("event.preventDefault()"));
assert(chrome.includes("event.stopImmediatePropagation()"));
assert(chrome.includes("CGAntiCurseProRecoveryGuard"));
assert(!chrome.includes("setInterval("));
assert(!/(^|[^\w])(eval|Function)\s*\(/.test(chrome));

for (const [browser, manifest] of [["chrome", chromeManifest], ["firefox", firefoxManifest]]) {
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
  const guard = scripts.indexOf("pro-recovery-guard.js");
  const recovery = scripts.indexOf("stall-recovery.js");
  assert(guard >= 0, `${browser}: Pro recovery guard must be packaged`);
  assert(recovery >= 0, `${browser}: stall recovery must be packaged`);
  assert(guard < recovery, `${browser}: Pro guard must install before stall recovery`);
}

console.log("Pro model exclusion, request-slug recovery, localized preset mapping, and fail-closed safety: PASS");
