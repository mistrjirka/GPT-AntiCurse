/*
 * Chromium MAIN-world response interceptor.
 *
 * Manifest V3 Chromium does not expose Firefox's filterResponseData() API to
 * normal extensions. This packaged MAIN-world script therefore wraps
 * Response.json()/text() only for ChatGPT's conversation-document endpoint.
 */
(function () {
  "use strict";

  const CHANNEL = "__gpt_anticurse_v1__";
  const VALID_MODES = new Set(["recent", "windowed-visible"]);
  const DEFAULT_SETTINGS = Object.freeze({ enabled: true, mode: "recent", maxDisplayMessages: 64 });
  let settings = { ...DEFAULT_SETTINGS };

  function normalizeMessageLimit(value) {
    const number = Number(value);
    return Math.max(4, Math.min(500, Number.isFinite(number) ? number : 64));
  }

  function resolveMode(value) {
    return VALID_MODES.has(value) ? value : "recent";
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

  function publishDiagnostic(code, message) {
    publish("diagnostic", {
      diagnostic: { scope: "chromium-main", code, message: String(message || code) }
    });
  }

  function applySettings(next) {
    if (!next || typeof next !== "object") return;
    if (typeof next.enabled === "boolean") settings.enabled = next.enabled;
    settings.mode = resolveMode(next.mode);
    if (Number.isFinite(Number(next.maxDisplayMessages))) settings.maxDisplayMessages = normalizeMessageLimit(next.maxDisplayMessages);
  }

  function canTransform(response) {
    const gate = globalThis.CGAntiCurseResponseGate;
    return !gate || typeof gate.canTransform !== "function" || gate.canTransform(response);
  }

  function reportStartupPassthrough(transport) {
    publishStats({ mode: "passthrough", transport, reason: "startup-barrier-timeout", trimMode: resolveMode(settings.mode) });
  }

  function transformConversation(data, originalBytes) {
    const started = performance.now();
    const mode = resolveMode(settings.mode);
    const limit = normalizeMessageLimit(settings.maxDisplayMessages);
    const transformed = CGTrim.trimConversation(data, { mode, maxDisplayMessages: limit });
    publishTransformStats(transformed, originalBytes, started);
    return transformed.changed ? transformed.data : data;
  }

  function publishTransformStats(transformed, originalBytes, started) {
    if (!transformed.changed) {
      if (transformed.reason === "unsupported-shape") {
        const message = "Unsupported ChatGPT conversation response shape; original response kept.";
        publishDiagnostic("unsupported-conversation-shape", message);
        publishStats({
          mode: "error",
          transport: "chromium-response-body",
          reason: transformed.reason,
          error: message,
          originalBytes,
          processingMs: +(performance.now() - started).toFixed(2)
        });
        return;
      }
      publishStats({
        mode: "passthrough",
        transport: "chromium-response-body",
        reason: transformed.reason,
        originalBytes,
        processingMs: +(performance.now() - started).toFixed(2),
        ...(transformed.stats || {})
      });
      return;
    }

    let outputBytes;
    try {
      outputBytes = new TextEncoder().encode(JSON.stringify(transformed.data)).byteLength;
    } catch (error) {
      // Size accounting is optional; transformation itself remains valid.
      console.debug("[GPT AntiCurse] Could not measure transformed response size", error);
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
    const text = String(error && error.message ? error.message : error);
    publishDiagnostic("conversation-transform-failed", text);
    publishStats({ mode: "error", transport, error: text });
  }

  function installResponseJsonWrapper() {
    const nativeJson = Response.prototype.json;
    Object.defineProperty(Response.prototype, "json", {
      configurable: true,
      writable: true,
      value: async function antiCurseJson() {
        const data = await nativeJson.call(this);
        if (!settings.enabled || !isConversationDocument(this.url)) return data;
        if (!canTransform(this)) {
          reportStartupPassthrough("chromium-response-json");
          return data;
        }
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
        if (!canTransform(this)) {
          reportStartupPassthrough("chromium-response-text");
          return text;
        }
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

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.type !== "settings") return;
    applySettings(message.settings);
  });

  installResponseJsonWrapper();
  installResponseTextWrapper();
  // The isolated bridge also publishes settings when storage resolves, so polling is unnecessary.
  publish("settings-request", {});
})();
