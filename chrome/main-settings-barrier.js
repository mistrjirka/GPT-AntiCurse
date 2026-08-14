/*
 * Chromium MAIN-world startup barrier and authoritative transient archive.
 *
 * The interceptor is installed at document_start, but a transformed conversation
 * is not delivered to ChatGPT until authoritative trim settings are known and
 * the initial server-rendered page has crossed its hydration boundary.
 *
 * The full visible archive is published once to the isolated world for current-
 * page history. Persistence is an isolated-world concern; MAIN world deliberately
 * does not read or retain the user's backup preference.
 */
(() => {
  "use strict";

  const CHANNEL = "__gpt_anticurse_v1__";
  const WAIT_MS = 8000;
  let settingsSettled = false;
  let hydrationSettled = false;
  let resolveSettingsReady;
  let resolveHydrationReady;

  const settingsReady = new Promise((resolve) => { resolveSettingsReady = resolve; });
  const hydrationReady = new Promise((resolve) => { resolveHydrationReady = resolve; });

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
    if (!message || message.channel !== CHANNEL || message.type !== "settings" || settingsSettled) return;
    settingsSettled = true;
    resolveSettingsReady();
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
    if (settingsSettled && hydrationSettled) return;
    await Promise.race([
      Promise.all([settingsReady, hydrationReady]),
      new Promise((resolve) => setTimeout(resolve, WAIT_MS))
    ]);
  }

  function publishArchive(data) {
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
      try {
        let body = text;
        if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
        publishArchive(JSON.parse(body));
      } catch (_) {}
      return text;
    }
  });
})();
