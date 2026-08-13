/*
 * Chromium MAIN-world startup barrier.
 *
 * The MAIN world cannot read chrome.storage directly. Delay consumption of the
 * conversation response for a short bounded period until the isolated-world
 * bridges have delivered both AntiCurse settings and the backup toggle.
 */
(() => {
  "use strict";

  const CHANNEL = "__gpt_anticurse_v1__";
  const WAIT_MS = 300;
  let trimSettingsReady = false;
  let archiveSettingsReady = false;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  function maybeResolve() {
    if (trimSettingsReady && archiveSettingsReady) resolveReady();
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL) return;
    if (message.type === "settings") trimSettingsReady = true;
    if (message.type === "archive-settings") archiveSettingsReady = true;
    maybeResolve();
  });

  function isConversationDocument(urlString) {
    try {
      const url = new URL(urlString, location.href);
      return url.origin === location.origin && /^\/backend-api\/conversation\/[^/]+\/?$/.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  async function waitForSettings() {
    if (trimSettingsReady && archiveSettingsReady) return;
    await Promise.race([
      ready,
      new Promise((resolve) => setTimeout(resolve, WAIT_MS))
    ]);
  }

  const nativeJson = Response.prototype.json;
  Object.defineProperty(Response.prototype, "json", {
    configurable: true,
    writable: true,
    value: async function antiCurseSettingsBarrierJson() {
      if (isConversationDocument(this.url)) await waitForSettings();
      return nativeJson.call(this);
    }
  });

  const nativeText = Response.prototype.text;
  Object.defineProperty(Response.prototype, "text", {
    configurable: true,
    writable: true,
    value: async function antiCurseSettingsBarrierText() {
      if (isConversationDocument(this.url)) await waitForSettings();
      return nativeText.call(this);
    }
  });
})();
