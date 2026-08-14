/*
 * Chromium MAIN-world startup barrier and authoritative pre-transform backup.
 *
 * Two things must be true before ChatGPT receives a transformed conversation:
 *  1. the isolated-world bridge has delivered authoritative extension settings;
 *  2. the initial server-rendered page has crossed its hydration boundary.
 *
 * The interceptor itself is installed at document_start, so ChatGPT can never
 * consume the untrimmed response first. On a hard SSR load the response promise
 * is simply held until load + two animation frames + an idle slice. This avoids
 * giving React a client graph that disagrees with its server HTML mid-hydration.
 */
(() => {
  "use strict";

  const CHANNEL = "__gpt_anticurse_v1__";
  const WAIT_MS = 8000;
  let trimSettingsReady = false;
  let archiveSettingsReady = false;
  let archiveEnabled = false;
  let resolveSettingsReady;
  let hydrationSettled = false;
  let resolveHydrationReady;

  const settingsReady = new Promise((resolve) => { resolveSettingsReady = resolve; });
  const hydrationReady = new Promise((resolve) => { resolveHydrationReady = resolve; });

  function maybeResolveSettings() {
    if (trimSettingsReady && archiveSettingsReady) resolveSettingsReady();
  }

  function finishHydration() {
    if (hydrationSettled) return;
    hydrationSettled = true;
    resolveHydrationReady();
  }

  function settleAfterLoad() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (typeof requestIdleCallback === "function") requestIdleCallback(finishHydration, { timeout: 1000 });
      else setTimeout(finishHydration, 0);
    }));
  }

  if (document.readyState === "complete") settleAfterLoad();
  else window.addEventListener("load", settleAfterLoad, { once: true });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL) return;
    if (message.type === "settings") trimSettingsReady = true;
    if (message.type === "archive-settings") {
      archiveSettingsReady = true;
      archiveEnabled = message.archiveEnabled !== false;
    }
    maybeResolveSettings();
  });

  function isConversationDocument(urlString) {
    try {
      const url = new URL(urlString, location.href);
      return url.origin === location.origin && /^\/backend-api\/conversation\/[^/]+\/?$/.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  async function waitForSafeDelivery() {
    if (trimSettingsReady && archiveSettingsReady && hydrationSettled) return;
    await Promise.race([
      Promise.all([settingsReady, hydrationReady]),
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
      await waitForSafeDelivery();
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
      await waitForSafeDelivery();
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
