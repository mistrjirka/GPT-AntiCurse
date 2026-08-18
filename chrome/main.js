/*
 * Chromium MAIN-world conversation interceptor.
 *
 * Manifest V3 Chromium does not expose Firefox's filterResponseData() API to
 * ordinary extensions. AntiCurse therefore installs document-start wrappers
 * around Response.json()/text(), scoped strictly to ChatGPT's conversation GET.
 *
 * Both wrappers feed one ordered pipeline:
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

  function elapsed(started) {
    return +(performance.now() - started).toFixed(2);
  }

  function errorText(error) {
    return String(error && error.message ? error.message : error || "Unknown error");
  }

  function responseMeta(response) {
    const contentType = response && response.headers && typeof response.headers.get === "function"
      ? response.headers.get("content-type") || ""
      : "";
    return {
      responseStatus: Number(response && response.status) || 0,
      responseOk: !!(response && response.ok),
      responseContentType: contentType
    };
  }

  function shapeSummary(data) {
    const isArray = Array.isArray(data);
    const isObject = data !== null && typeof data === "object";
    const record = isObject && !isArray ? data : null;
    const mapping = record ? record.mapping : null;
    const mappingObject = mapping !== null && typeof mapping === "object" && !Array.isArray(mapping);
    const currentNode = record ? record.current_node : null;
    const keys = record ? Object.keys(record).slice(0, 24) : [];
    const supported = !!(mappingObject && currentNode && mapping[currentNode]);
    return {
      shapeSupported: supported,
      shapeDataType: data === null ? "null" : isArray ? "array" : typeof data,
      shapeTopLevelKeys: keys.join(","),
      shapeArrayLength: isArray ? data.length : null,
      shapeHasMapping: !!(record && Object.prototype.hasOwnProperty.call(record, "mapping")),
      shapeMappingType: mapping === null ? "null" : Array.isArray(mapping) ? "array" : typeof mapping,
      shapeMappingNodeCount: mappingObject ? Object.keys(mapping).length : null,
      shapeHasCurrentNode: !!(record && Object.prototype.hasOwnProperty.call(record, "current_node")),
      shapeCurrentNodeType: currentNode === null ? "null" : typeof currentNode,
      shapeCurrentNodePresent: supported
    };
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
      void error;
      return false;
    }
  }

  function conversationIdFromEndpoint(urlString) {
    return globalThis.CGArchive && typeof globalThis.CGArchive.conversationIdFromUrl === "function"
      ? globalThis.CGArchive.conversationIdFromUrl(urlString)
      : null;
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

  function publishArchive(data, endpointUrl) {
    const buildStarted = performance.now();
    const conversationId = conversationIdFromEndpoint(endpointUrl);
    const shape = shapeSummary(data);
    if (!shape.shapeSupported) {
      return {
        archiveOk: false,
        archiveSkipped: "unsupported-shape",
        archiveBuildMs: elapsed(buildStarted),
        archiveMessageCount: 0
      };
    }
    try {
      const archive = CGArchive.createArchive(data, { endpointUrl });
      const archiveBuildMs = elapsed(buildStarted);
      if (!archive) {
        publishDiagnostic("archive-build-empty", "The conversation response could not be converted to an archive.", { conversationId });
        return { archiveOk: false, archiveBuildMs, archiveMessageCount: 0 };
      }
      const postStarted = performance.now();
      publish("archive", { archive });
      return {
        archiveOk: true,
        archiveBuildMs,
        archivePostMs: elapsed(postStarted),
        archiveMessageCount: Array.isArray(archive.messages) ? archive.messages.length : 0
      };
    } catch (error) {
      const archiveBuildMs = elapsed(buildStarted);
      publishDiagnostic("archive-build-failed", error, { archiveBuildMs, conversationId });
      return { archiveOk: false, archiveBuildMs, archiveMessageCount: 0 };
    }
  }

  function publishTransformStats(transformed, originalBytes, started, trace = {}) {
    if (!transformed.changed) {
      if (transformed.reason === "unsupported-shape") {
        const message = "Unsupported ChatGPT conversation response shape; original response kept.";
        const shape = shapeSummary(transformed.data);
        publishDiagnostic("unsupported-conversation-shape", message, { ...trace, ...shape });
        publishStats({
          mode: "error",
          transport: "chromium-response-body",
          reason: transformed.reason,
          error: message,
          originalBytes,
          processingMs: elapsed(started),
          ...trace,
          ...shape
        });
        return;
      }
      publishStats({
        mode: "passthrough",
        transport: "chromium-response-body",
        reason: transformed.reason,
        originalBytes,
        processingMs: elapsed(started),
        ...(transformed.stats || {}),
        ...trace
      });
      return;
    }

    let outputBytes;
    try {
      outputBytes = new TextEncoder().encode(JSON.stringify(transformed.data)).byteLength;
    } catch (error) {
      console.debug("[GPT AntiCurse] Could not measure transformed response size", error);
      outputBytes = undefined;
    }

    publishStats({
      mode: "trimmed",
      transport: "chromium-response-body",
      originalBytes,
      outputBytes,
      processingMs: elapsed(started),
      ...transformed.stats,
      ...trace
    });
  }

  function transformConversation(data, originalBytes, trace) {
    const started = performance.now();
    const transformed = CGTrim.trimConversation(data, {
      mode: resolveMode(settings.mode),
      maxDisplayMessages: normalizeMessageLimit(settings.maxDisplayMessages)
    });
    publishTransformStats(transformed, originalBytes, started, trace);
    return transformed.changed ? transformed.data : data;
  }

  function reportTransformError(transport, error, trace = {}) {
    const text = errorText(error);
    publishDiagnostic("conversation-transform-failed", text, trace);
    publishStats({ mode: "error", transport, error: text, ...trace });
  }

  function reportStartupPassthrough(transport, trace = {}) {
    publishStats({
      mode: "passthrough",
      transport,
      reason: settingsSettled && !settings.enabled ? "disabled" : "startup-barrier-timeout",
      trimMode: resolveMode(settings.mode),
      ...trace
    });
  }

  const JSON_BODY = Object.freeze({
    transport: "chromium-response-json",
    decode(body) {
      return { data: body, trace: {} };
    },
    originalBytes() {
      return undefined;
    },
    encode(_originalBody, _originalData, transformed) {
      return transformed;
    }
  });

  const TEXT_BODY = Object.freeze({
    transport: "chromium-response-text",
    parseFailureCode: "conversation-json-parse-failed",
    decode(text) {
      const parseStarted = performance.now();
      let body = text;
      if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
      const data = JSON.parse(body);
      return { data, trace: { jsonParseMs: elapsed(parseStarted) } };
    },
    originalBytes(text) {
      return new TextEncoder().encode(text).byteLength;
    },
    encode(originalText, originalData, transformed) {
      return transformed === originalData ? originalText : JSON.stringify(transformed);
    }
  });

  async function interceptConversationResponse(response, readBody, bodyAdapter) {
    if (!isConversationDocument(response.url)) return readBody();

    const endpointUrl = response.url;
    const meta = {
      ...responseMeta(response),
      conversationId: conversationIdFromEndpoint(endpointUrl)
    };
    if (!meta.responseOk) {
      const readStarted = performance.now();
      const body = await readBody();
      publishStats({
        mode: "passthrough",
        transport: bodyAdapter.transport,
        reason: "http-status",
        responseReadMs: elapsed(readStarted),
        ...meta
      });
      return body;
    }

    const interceptStarted = performance.now();
    const safeToTransform = await waitForTransformSafety();
    const safetyWaitMs = elapsed(interceptStarted);
    const readStarted = performance.now();
    const originalBody = await readBody();
    const responseReadMs = elapsed(readStarted);

    let decoded;
    try {
      decoded = bodyAdapter.decode(originalBody);
    } catch (error) {
      publishDiagnostic(bodyAdapter.parseFailureCode || "conversation-body-decode-failed", error, {
        ...meta,
        safetyWaitMs,
        responseReadMs
      });
      return originalBody;
    }

    const data = decoded.data;
    const trace = {
      ...meta,
      safetyWaitMs,
      responseReadMs,
      ...(decoded.trace || {}),
      ...publishArchive(data, endpointUrl)
    };

    if (!settings.enabled || !safeToTransform) {
      reportStartupPassthrough(bodyAdapter.transport, trace);
      return originalBody;
    }

    try {
      const transformed = transformConversation(data, bodyAdapter.originalBytes(originalBody), trace);
      return bodyAdapter.encode(originalBody, data, transformed);
    } catch (error) {
      reportTransformError(bodyAdapter.transport, error, trace);
      return originalBody;
    }
  }

  const nativeJson = Response.prototype.json;
  Object.defineProperty(Response.prototype, "json", {
    configurable: true,
    writable: true,
    value: function antiCurseJson() {
      return interceptConversationResponse(this, () => nativeJson.call(this), JSON_BODY);
    }
  });

  const nativeText = Response.prototype.text;
  Object.defineProperty(Response.prototype, "text", {
    configurable: true,
    writable: true,
    value: function antiCurseText() {
      return interceptConversationResponse(this, () => nativeText.call(this), TEXT_BODY);
    }
  });

  publish("settings-request", {});
})();
