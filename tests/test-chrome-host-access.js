"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const manifest = JSON.parse(read("chrome/manifest.json"));
const popupContext = read("chrome/popup-context.js");
const popup = read("chrome/popup.js");
const backupPopup = read("chrome/backup-popup.js");
const diagnostics = read("chrome/diagnostics.js");
const popupHtml = read("chrome/popup.html");

assert(manifest.host_permissions.includes("https://chatgpt.com/*"), "Chromium must request ChatGPT host access");
assert(popupContext.includes("chrome.permissions.contains"), "shared popup context must detect withheld runtime host access");
assert(popupContext.includes("function isChatGPTTab"), "ChatGPT tab detection should have one popup owner");
assert(popupContext.includes("function currentTab"), "active-tab lookup should have one popup owner");
assert(popupContext.includes("function conversationIdFromTab"), "popup stats lookup should share route identity parsing");
assert(popup.includes("popupContext.hasPackageHostAccess"), "main popup must use shared host-access detection");
assert(popup.includes("chrome.permissions.request"), "Save & reload must be able to request a withheld required host permission");
assert(popup.includes('addEventListener("click", saveAndReloadFromUserGesture)'), "host permission request must originate directly from the Save & reload user gesture");
assert(popup.includes('.then((granted) => finishSaveAndReload(granted))'), "reload path must continue only after the host permission request resolves");
assert(popup.includes("async function finishSaveAndReload(granted)"), "post-permission reload path must receive the grant result explicitly");
assert(popup.includes("popupContext.isChatGPTTab(tab) && !granted"), "a denied host request must stop before reload");
assert(popup.includes("await chrome.tabs.reload(tab.id)"), "successful host access must reload the tab for document_start scripts");
assert(popup.includes('setStatus("Needs access"'), "withheld host access needs a distinct user-visible state");
assert(popup.includes('setStatus("Reload required"'), "a granted host with no content script must be diagnosed as a stale/missing bridge");
assert(popup.includes('diagnostics.record("bridge", "content-script-missing"'), "missing page receiver must be a bridge diagnostic, not an archive diagnostic");
assert(backupPopup.includes('recordIssue("bridge", "popup-page-bridge-failed", error, { export: true })'), "export UI must record page-bridge failures only on the explicit export action");
assert(backupPopup.includes("popupContext.hasPackageHostAccess"), "backup UI must share package host-access detection");
assert(backupPopup.includes("chrome.permissions.contains"), "debug report should still probe the actual Chromium runtime permission independently");
assert(popupHtml.indexOf('src="popup-context.js"') < popupHtml.indexOf('src="popup.js"'), "shared popup context must load before popup controllers");
assert(diagnostics.includes("function clear(scope, code)"), "diagnostics must support clearing only the recovered legacy bridge issue");
assert(popup.includes("issue.message"), "popup must display the diagnostic message, not only its code");

console.log("Chromium host-access checks: PASS");
