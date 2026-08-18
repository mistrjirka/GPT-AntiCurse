/* Shared popup environment helpers; no UI ownership. */
(function (global) {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const manifest = ext.runtime.getManifest();
  const isFirefoxPackage = !!(manifest.browser_specific_settings && manifest.browser_specific_settings.gecko);
  const packageTarget = isFirefoxPackage ? "firefox" : "chromium";
  const runtimeBrowser = /Firefox\//.test(String(navigator.userAgent || "")) ? "firefox" : "chromium";
  const backgroundKind = manifest.background && manifest.background.service_worker
    ? "service_worker"
    : manifest.background && Array.isArray(manifest.background.scripts)
      ? "scripts"
      : "none";
  const diagnostics = global.CGAntiCurseDiagnostics;
  const CHATGPT_ORIGIN = "https://chatgpt.com/*";

  function errorText(error) {
    return String(error && error.message ? error.message : error || "Unknown error");
  }

  async function currentTab() {
    return (await ext.tabs.query({ active: true, currentWindow: true }))[0] || null;
  }

  function isChatGPTTab(tab) {
    return !!(tab && typeof tab.url === "string" && /^https:\/\/chatgpt\.com\//.test(tab.url));
  }

  function conversationIdFromTab(tab) {
    if (!isChatGPTTab(tab)) return null;
    try {
      const match = new URL(tab.url).pathname.match(/(?:^|\/)c\/([^/?#]+)/);
      return match ? decodeURIComponent(match[1]) : null;
    } catch (_) {
      return null;
    }
  }

  async function hasPackageHostAccess(tab) {
    if (isFirefoxPackage || !isChatGPTTab(tab)) return true;
    if (typeof chrome === "undefined" || !chrome.permissions) return false;
    return chrome.permissions.contains({ origins: [CHATGPT_ORIGIN] });
  }

  global.CGPopupContext = Object.freeze({
    ext,
    manifest,
    diagnostics,
    CHATGPT_ORIGIN,
    isFirefoxPackage,
    packageTarget,
    runtimeBrowser,
    backgroundKind,
    errorText,
    currentTab,
    isChatGPTTab,
    conversationIdFromTab,
    hasPackageHostAccess
  });
})(globalThis);
