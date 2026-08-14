"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const manifest = JSON.parse(read("chrome/manifest.json"));
const popup = read("chrome/popup.js");
const backupPopup = read("chrome/backup-popup.js");
const diagnostics = read("chrome/diagnostics.js");

assert(manifest.host_permissions.includes("https://chatgpt.com/*"), "Chromium must request ChatGPT host access");
assert(popup.includes("chrome.permissions.contains"), "popup must detect withheld runtime host access");
assert(popup.includes("chrome.permissions.request"), "Save & reload must be able to request a withheld required host permission");
assert(popup.includes('setStatus("Needs access"'), "withheld host access needs a distinct user-visible state");
assert(popup.includes('setStatus("Reload required"'), "a granted host with no content script must be diagnosed as a stale/missing bridge");
assert(popup.includes('diagnostics.record("bridge", "content-script-missing"'), "missing page receiver must be a bridge diagnostic, not an archive diagnostic");
assert(popup.indexOf("requestHostAccess") < popup.indexOf("chrome.tabs.reload"), "host access must be acquired before the document_start reload");
assert(backupPopup.includes('recordIssue("bridge", "popup-page-bridge-failed"'), "backup UI must classify page messaging failures as bridge failures");
assert(backupPopup.includes("chrome.permissions.contains"), "backup UI must distinguish withheld Chrome host access from a dead receiver");
assert(diagnostics.includes("function clear(scope, code)"), "diagnostics must support clearing only the recovered legacy bridge issue");
assert(popup.includes("issue.message"), "popup must display the diagnostic message, not only its code");

console.log("Chromium host-access checks: PASS");
