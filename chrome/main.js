/*
 * Chromium MAIN-world response interceptor.
 *
 * Normal Manifest V3 extensions do not have Firefox's filterResponseData() API.
 * This packaged script therefore wraps Response.json()/text() only for the exact
 * ChatGPT conversation-document endpoint. It never loads remote code.
 */
(function () {
  "use strict";

  const CHANNEL = "__gpt_anticurse_v1__";
  const LIMITED_MODES = new Set(["recent", "latest-visible", "windowed-visible"]);
  const VALID_MODES = new Set(["visible-history", ...LIMITED_MODES]);
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    mode: "visible-history",
    maxDisplayMessages: 64
  });

  let settings = { ...DEFAULT_SETTINGS };

  function normalizeMessageLimit(value) {
    const number = Number(value);
    return Math.max(4, Math.min(500, Number.isFinite(number) ? number : 64));
  }

  function resolveMode(value) {
    return VALID_MODES.has(value) ? value : "visible-history";
  }

  function isConversationDocument(urlString) {
    try {
      const url = new URL(urlString, location.href);
      return url.origin === location.origin && /^\/backend-api\/conversation\/[^/]+\/?$/.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  function publish(type, payload) {
    window.postMessage({ channel: CHANNEL, type, ...payload }, location.origin);
  }

  function publishStats(stats) {
    publish("stats", { stats });
  }

  function publishHistory(history) {
    publish("history", { history });
  }

  function applySettings(next) {
    if (!next || typeof next !== "object") return;
    if (typeof next.enabled === "boolean") settings.enabled = next.enabled;
    if (VALID_MODES.has(next.mode)) settings.mode = next.mode;
    if (Number.isFinite(Number(next.maxDisplayMessages))) {
      settings.maxDisplayMessages = normalizeMessageLimit(next.maxDisplayMessages);
    }
  }

  function buildHistoryArchive(data, transformed, mode, limit) {
    if (!LIMITED_MODES.has(mode)) return null;

    const messages = CGTrim.extractVisibleHistory(data);
    const fallbackNativeCount = Math.min(messages.length, limit);
    const nativeVisibleCount = transformed.stats && Number.isFinite(Number(transformed.stats.displayAfter))
      ? Math.max(0, Number(transformed.stats.displayAfter))
      : fallbackNativeCount;

    return {
      messages,
      nativeVisibleCount,
      pageSize: limit,
      maxRendered: Math.max(limit, Math.min(500, limit * 3))
    };
  }

  function transformConversation(data, originalBytes) {
    const started = performance.now();
    const mode = resolveMode(settings.mode);
    const limit = normalizeMessageLimit(settings.maxDisplayMessages);
    const transformed = CGTrim.trimConversation(data, {
      mode,
      maxDisplayMessages: limit
    });

    publishHistory(buildHistoryArchive(data, transformed, mode, limit));
    publishTransformStats(transformed, originalBytes, started);

    return transformed.changed ? transformed.data : data;
  }

  function publishTransformStats(transformed, originalBytes, started) {
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
      return;
    }

    let outputBytes;
    try {
      outputBytes = new TextEncoder().encode(JSON.stringify(transformed.data)).byteLength;
    } catch (_) {
      outputBytes = undefined;
    }

    publishStats({
      mode: "trimmed",
      transport: "chromium-response-body",
      originalBytes,
      outputBytes,
      processingMs: +(performance.now() - started).toFixed(2),
      ...transformed.stats
    });
  }

  function reportError(transport, error) {
    publishStats({
      mode: "error",
      transport,
      error: String(error && error.message ? error.message : error)
    });
  }

  function installResponseJsonWrapper() {
    const nativeJson = Response.prototype.json;
    Object.defineProperty(Response.prototype, "json", {
      configurable: true,
      writable: true,
      value: async function antiCurseJson() {
        const data = await nativeJson.call(this);
        if (!settings.enabled || !isConversationDocument(this.url)) return data;

        try {
          return transformConversation(data, undefined);
        } catch (error) {
          reportError("chromium-response-json", error);
          return data;
        }
      }
    });
  }

  function installResponseTextWrapper() {
    const nativeText = Response.prototype.text;
    Object.defineProperty(Response.prototype, "text", {
      configurable: true,
      writable: true,
      value: async function antiCurseText() {
        const text = await nativeText.call(this);
        if (!settings.enabled || !isConversationDocument(this.url)) return text;

        try {
          let body = text;
          if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
          const data = JSON.parse(body);
          const transformed = transformConversation(data, new TextEncoder().encode(text).byteLength);
          return transformed === data ? text : JSON.stringify(transformed);
        } catch (error) {
          reportError("chromium-response-text", error);
          return text;
        }
      }
    });
  }

  function requestSettings() {
    publish("settings-request", {});
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.type !== "settings") return;
    applySettings(message.settings);
  });

  installResponseJsonWrapper();
  installResponseTextWrapper();

  requestSettings();
  setTimeout(requestSettings, 0);
  setTimeout(requestSettings, 100);
})();
