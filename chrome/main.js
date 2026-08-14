/*
 * Chromium MAIN-world conversation interceptor.
 *
 * Manifest V3 Chromium does not expose Firefox's filterResponseData() API to
 * ordinary extensions. AntiCurse therefore installs one document-start wrapper
 * around Response.json()/text(), scoped strictly to ChatGPT's conversation GET.
 *
 * The wrapper has a single ordered pipeline:
 *   1. wait for authoritative settings and, when enabled, the hydration boundary;
 *   2. read the untouched conversation;
 *   3. publish one minimal visible-history archive to the isolated world;
 *   4. trim a copy for ChatGPT, or fail open with an explicit diagnostic.
 */
(function () {
  "use strict";

  const CHANNEL = "__gpt_anticurse_v1__";
  const SETTINGS_WAIT_MS = 2500;
  const HYDRATION_WAIT_MS = 8000;
  const VALID_MODES = new Set(["recent", "windowed-visible"]);
  const DEFAULT_SETTINGS = Object.freeze({ enabled: true, mode: "recent", maxDisplayMessages: 64 });

  let settings = { ...DEFAULT_SETTINGS };
  let settingsSettled = false;
  let hydrationSettled = false;
  let resolveSettingsReady;
  let resolveHydrationReady;

  const settingsReady = new Promise((resolve) => { resolveSettingsReady = resolve; });
  const hydrationReady = new Promise((resolve) => { resolveHydrationReady = resolve; });

  function errorText(error) {
    return String(error && error.message ? error.message : error || "Unknown error");
  }

  function normalizeMessageLimit(value) {
    const number = Number(value);
    return Math.max(4, Math.min(500, Number.isFinite(number) ? number : 64));
  }

  function resolveMode(value) {
    return VALID_MODES.has(value) ? value : "recent";
  }

  function applySettings(next) {
    if (!next || typeof next !== "object") return;
    if (typeof next.enabled === "boolean") settings.enabled = next.enabled;
    settings.mode = resolveMode(next.mode);
    if (Number.isFinite(Number(next.maxDisplayMessages))) {
      settings.maxDisplayMessages = normalizeMessageLimit(next.maxDisplayMessages);
    }
  }

  function isConversationDocument(urlString) {
    try {
      const url = new URL(urlString, location.href);
      return url.origin === location.origin && /^\/backend-api\/conversation\/[^/]+\/?$/.test(url.pathname);
    } catch (error) {
      // A Response without a parseable URL cannot be the scoped endpoint.
      void error;
      return false;
    }
  }

  function publish(type, payload) {
    window.postMessage({ channel: CHANNEL, type, ...payload }, location.origin);
  }

  function publishStats(stats) {
    publish("stats", { stats });
  }

  function publishDiagnostic(code, error, extra = {}) {
    publish("diagnostic", {
      diagnostic: {
        scope: "chromium-main",
        code,
        message: errorText(error),
        extra
      }
    });
  }

  function finishHydration() {
    if (hydrationSettled) return;
    hydrationSettled = true;
    resolveHydrationReady();
  }

  function settleAfterLoad() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(finishHydration, { timeout: 1000 });
      } else {
        setTimeout(finishHydration, 0);
      }
    }));
  }

  if (document.readyState === "complete") settleAfterLoad();
  else window.addEventListener("load", settleAfterLoad, { once: true });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.type !== "settings") return;
    applySettings(message.settings);
    if (!settingsSettled) {
      settingsSettled = true;
      resolveSettingsReady();
    }
  });

  async function waitForTransformSafety() {
    if (!settingsSettled) {
      let timedOut = false;
      await Promise.race([
        settingsReady,
        new Promise((resolve) => setTimeout(() => {
          timedOut = true;
          resolve();
        }, SETTINGS_WAIT_MS))
      ]);
      if (timedOut && !settingsSettled) {
        publishDiagnostic(
          "startup-barrier-timeout",
          "Authoritative extension settings did not arrive before the conversation timeout.",
          { phase: "settings", waitMs: SETTINGS_WAIT_MS }
        );
        return false;
      }
    }

    if (!settings.enabled) return false;
    if (hydrationSettled) return true;

    let timedOut = false;
    await Promise.race([
      hydrationReady,
      new Promise((resolve) => setTimeout(() => {
        timedOut = true;
        resolve();
      }, HYDRATION_WAIT_MS))
    ]);

    if (hydrationSettled) return true;
    if (timedOut) {
      publishDiagnostic(
        "startup-barrier-timeout",
        "ChatGPT hydration did not settle before the conversation timeout; original response kept.",
        { phase: "hydration", waitMs: HYDRATION_WAIT_MS }
      );
    }
    return false;
  }

  function publishArchive(data) {
    try {
      const archive = CGArchive.createArchive(data, { sourceUrl: location.href });
      if (!archive) {
        publishDiagnostic("archive-build-empty", "The conversation response could not be converted to an archive.");
        return false;
      }
      publish("archive", { archive });
      return true;
    } catch (error) {
      publishDiagnostic("archive-build-failed", error);
      return false;
    }
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
      // Byte accounting is cosmetic; the graph transformation remains valid.
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

  function transformConversation(data, originalBytes) {
    const started = performance.now();
    const transformed = CGTrim.trimConversation(data, {
      mode: resolveMode(settings.mode),
      maxDisplayMessages: normalizeMessageLimit(settings.maxDisplayMessages)
    });
    publishTransformStats(transformed, originalBytes, started);
    return transformed.changed ? transformed.data : data;
  }

  function reportTransformError(transport, error) {
    const text = errorText(error);
    publishDiagnostic("conversation-transform-failed", text);
    publishStats({ mode: "error", transport, error: text });
  }

  function reportStartupPassthrough(transport) {
    publishStats({
      mode: "passthrough",
      transport,
      reason: settingsSettled && !settings.enabled ? "disabled" : "startup-barrier-timeout",
      trimMode: resolveMode(settings.mode)
    });
  }

  const nativeJson = Response.prototype.json;
  Object.defineProperty(Response.prototype, "json", {
    configurable: true,
    writable: true,
    value: async function antiCurseJson() {
      if (!isConversationDocument(this.url)) return nativeJson.call(this);

      const safeToTransform = await waitForTransformSafety();
      const data = await nativeJson.call(this);
      publishArchive(data);

      if (!settings.enabled || !safeToTransform) {
        reportStartupPassthrough("chromium-response-json");
        return data;
      }

      try {
        return transformConversation(data, undefined);
      } catch (error) {
        reportTransformError("chromium-response-json", error);
        return data;
      }
    }
  });

  const nativeText = Response.prototype.text;
  Object.defineProperty(Response.prototype, "text", {
    configurable: true,
    writable: true,
    value: async function antiCurseText() {
      if (!isConversationDocument(this.url)) return nativeText.call(this);

      const safeToTransform = await waitForTransformSafety();
      const text = await nativeText.call(this);
      let data;
      try {
        let body = text;
        if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
        data = JSON.parse(body);
      } catch (error) {
        publishDiagnostic("conversation-json-parse-failed", error);
        return text;
      }

      publishArchive(data);
      if (!settings.enabled || !safeToTransform) {
        reportStartupPassthrough("chromium-response-text");
        return text;
      }

      try {
        const transformed = transformConversation(data, new TextEncoder().encode(text).byteLength);
        return transformed === data ? text : JSON.stringify(transformed);
      } catch (error) {
        reportTransformError("chromium-response-text", error);
        return text;
      }
    }
  });

  // The isolated settings bridge also publishes proactively after storage loads;
  // this request only handles the case where it was already ready first.
  publish("settings-request", {});
})();
