/*
 * Chromium MAIN-world startup barrier and authoritative pre-transform backup.
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
  let archiveEnabled = false;
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
    if (message.type === "archive-settings") {
      archiveSettingsReady = true;
      archiveEnabled = message.archiveEnabled !== false;
    }
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

  function publishArchive(data) {
    if (!archiveEnabled) return;
    try {
      const archive = CGArchive.createArchive(data, { sourceUrl: location.href });
      if (archive) window.postMessage({ channel: CHANNEL, type: "archive", archive }, location.origin);
    } catch (_) {}
  }

  const nativeJson = Response.prototype.json;
  Object.defineProperty(Response.prototype, "json", {
    configurable: true,
    writable: true,
    value: async function antiCurseSettingsBarrierJson() {
      if (!isConversationDocument(this.url)) return nativeJson.call(this);
      await waitForSettings();
      const data = await nativeJson.call(this);
      publishArchive(data);
      return data;
    }
  });

  const nativeText = Response.prototype.text;
  Object.defineProperty(Response.prototype, "text", {
    configurable: true,
    writable: true,
    value: async function antiCurseSettingsBarrierText() {
      if (!isConversationDocument(this.url)) return nativeText.call(this);
      await waitForSettings();
      const text = await nativeText.call(this);
      if (archiveEnabled) {
        try {
          let body = text;
          if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
          publishArchive(JSON.parse(body));
        } catch (_) {}
      }
      return text;
    }
  });
})();
