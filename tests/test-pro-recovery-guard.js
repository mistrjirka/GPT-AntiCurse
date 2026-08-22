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
assert(chrome.includes('slug.endsWith("-pro")'), "all explicit *-pro model slugs must be excluded");
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

console.log("Pro model auto-recovery exclusion: PASS");
