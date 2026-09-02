"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const chromeMain = read("chrome/main.js");
const chromeContent = read("chrome/content.js");
const chromeWindowed = read("chrome/windowed.js");
const chromePopup = read("chrome/popup.js");
const firefoxBackground = read("firefox/background.js");
const firefoxContent = read("firefox/content.js");
const firefoxWindowed = read("firefox/windowed.js");
const firefoxPopup = read("firefox/popup.js");
const chromeRecovery = read("chrome/stall-recovery.js");
const firefoxRecovery = read("firefox/stall-recovery.js");
const chromePopupHtml = read("chrome/popup.html");
const firefoxPopupHtml = read("firefox/popup.html");

// Performance Guard is opt-in on a fresh/default-less profile.
assert(chromeMain.includes('DEFAULT_SETTINGS = Object.freeze({ enabled: false,'));
assert(chromeContent.includes('DEFAULT_SETTINGS = { enabled: false,'));
assert(chromeWindowed.includes('DEFAULT_SETTINGS = Object.freeze({ enabled: false,'));
assert(chromePopup.includes('chrome.storage.local.get({ enabled: false,'));
assert(firefoxBackground.includes('const DEFAULT_SETTINGS = {\n  enabled: false,'));
assert(firefoxContent.includes('browser.storage.local.get({ enabled: false,'));
assert(firefoxWindowed.includes('DEFAULT_SETTINGS = Object.freeze({ enabled: false,'));
assert(firefoxPopup.includes('browser.storage.local.get({ enabled: false,'));

// Auto-Continue remains enabled independently and has a user-configurable stall timeout.
assert.equal(chromeRecovery, firefoxRecovery, "Auto-Continue controller must stay byte-identical across browsers");
assert(chromeRecovery.includes('stallRecoveryEnabled: true, stallRecoveryTimeoutSeconds: DEFAULT_STALL_TIMEOUT_SECONDS'));
assert(chromeRecovery.includes('const DEFAULT_STALL_TIMEOUT_SECONDS = 120;'));
assert(chromeRecovery.includes('const MIN_STALL_TIMEOUT_SECONDS = 10;'));
assert(chromeRecovery.includes('const MAX_STALL_TIMEOUT_SECONDS = 3600;'));
assert(chromeRecovery.includes('changes.stallRecoveryTimeoutSeconds'));
assert(chromeRecovery.includes('timeoutSeconds: settings.stallRecoveryTimeoutSeconds'));
assert(!chromeRecovery.includes('settings.enabled'), "Auto-Continue must not depend on Performance Guard state");

for (const html of [chromePopupHtml, firefoxPopupHtml]) {
  assert(html.includes('id="stallRecoveryTimeout"'));
  assert(html.includes('min="10" max="3600"'));
}
assert(chromePopup.includes('stallRecoveryTimeoutSeconds: stallRecoveryTimeoutSeconds()'));
assert(firefoxPopup.includes('stallRecoveryTimeoutSeconds: stallRecoveryTimeoutSeconds()'));
assert(firefoxBackground.includes('next.stallRecoveryTimeoutSeconds = normalizeStallRecoveryTimeoutSeconds'));

console.log("Settings defaults and Auto-Continue timeout: PASS");
