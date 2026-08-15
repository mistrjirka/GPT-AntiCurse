"use strict";

(() => {
  const startedAt = new Date().toISOString();
  const manifest = chrome.runtime.getManifest();
  let bootState = {
    ok: false,
    phase: "loading",
    startedAt,
    version: manifest.version
  };

  // Register this before loading the rest of the worker. If one imported script
  // throws at startup, the worker can still explain the failure to the popup.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "cg-background-health") return false;
    sendResponse({
      ...bootState,
      checkedAt: new Date().toISOString()
    });
    return false;
  });

  try {
    importScripts("diagnostics.js", "archive.js", "archive-export.js", "archive-store.js", "archive-background.js", "background.js");
    bootState = {
      ok: true,
      phase: "ready",
      startedAt,
      version: manifest.version
    };
  } catch (error) {
    bootState = {
      ok: false,
      phase: "import-failed",
      startedAt,
      version: manifest.version,
      error: String(error && error.message ? error.message : error),
      script: error && typeof error.fileName === "string" ? error.fileName : null,
      line: error && Number.isFinite(Number(error.lineNumber)) ? Number(error.lineNumber) : null
    };
    console.error("[GPT AntiCurse] Chromium service worker failed during startup", error);
  }
})();
