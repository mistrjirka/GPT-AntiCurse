(function () {
  "use strict";

  const CHANNEL = "__gpt_anticurse_v1__";
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    mode: "visible-history",
    maxDisplayMessages: 32
  });
  let settings = { ...DEFAULT_SETTINGS };

  function isExactConversationDocument(urlString) {
    try {
      const url = new URL(urlString, location.href);
      return url.origin === location.origin && /^\/backend-api\/conversation\/[^/]+\/?$/.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  function publishStats(stats) {
    window.postMessage({ channel: CHANNEL, type: "stats", stats }, location.origin);
  }

  function applySettings(next) {
    if (!next || typeof next !== "object") return;
    if (typeof next.enabled === "boolean") settings.enabled = next.enabled;
    if (next.mode === "visible-history" || next.mode === "recent") settings.mode = next.mode;
    if (Number.isFinite(Number(next.maxDisplayMessages))) {
      settings.maxDisplayMessages = Math.max(4, Math.min(500, Number(next.maxDisplayMessages)));
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.type !== "settings") return;
    applySettings(msg.settings);
  });

  function transformParsed(data, originalBytes) {
    const started = performance.now();
    const transformed = CGTrim.trimConversation(data, {
      mode: settings.mode === "recent" ? "recent" : "visible-history",
      maxDisplayMessages: settings.maxDisplayMessages
    });

    if (!transformed.changed) {
      if (transformed.reason !== "unsupported-shape") {
        publishStats({
          mode: "passthrough",
          transport: "chromium-response-body",
          reason: transformed.reason,
          originalBytes,
          processingMs: +(performance.now() - started).toFixed(2),
          ...(transformed.stats || {})
        });
      }
      return { data, transformed: false };
    }

    let outputBytes;
    try { outputBytes = new TextEncoder().encode(JSON.stringify(transformed.data)).byteLength; } catch (_) { outputBytes = undefined; }
    publishStats({
      mode: "trimmed",
      transport: "chromium-response-body",
      originalBytes,
      outputBytes,
      processingMs: +(performance.now() - started).toFixed(2),
      ...transformed.stats
    });
    return { data: transformed.data, transformed: true };
  }

  const nativeJson = Response.prototype.json;
  const nativeText = Response.prototype.text;

  Object.defineProperty(Response.prototype, "json", {
    configurable: true,
    writable: true,
    value: async function antiCurseJson() {
      const data = await nativeJson.call(this);
      if (!settings.enabled || !isExactConversationDocument(this.url)) return data;
      try {
        return transformParsed(data, undefined).data;
      } catch (error) {
        publishStats({
          mode: "error",
          transport: "chromium-response-json",
          error: String(error && error.message ? error.message : error)
        });
        return data;
      }
    }
  });

  Object.defineProperty(Response.prototype, "text", {
    configurable: true,
    writable: true,
    value: async function antiCurseText() {
      const text = await nativeText.call(this);
      if (!settings.enabled || !isExactConversationDocument(this.url)) return text;
      try {
        let body = text;
        if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
        const parsed = JSON.parse(body);
        const result = transformParsed(parsed, new TextEncoder().encode(text).byteLength);
        return result.transformed ? JSON.stringify(result.data) : text;
      } catch (error) {
        publishStats({
          mode: "error",
          transport: "chromium-response-text",
          error: String(error && error.message ? error.message : error)
        });
        return text;
      }
    }
  });

  function requestSettings() {
    window.postMessage({ channel: CHANNEL, type: "settings-request" }, location.origin);
  }
  requestSettings();
  setTimeout(requestSettings, 0);
  setTimeout(requestSettings, 100);
})();
