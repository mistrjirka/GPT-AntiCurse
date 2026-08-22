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
  const DEFAULT_SETTINGS = Object.freeze({ enabled: true, mode: "windowed-visible", maxDisplayMessages: 64 });
  const PAGINATION = globalThis.CGPaginationFirewall;
  const ENDPOINT = globalThis.CGConversationEndpoint;

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


  function paginatedConversationEnvelope(data) {
    return !!data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      Array.isArray(data.messages) &&
      !!data.page_info &&
      typeof data.page_info === "object" &&
      !Array.isArray(data.page_info);
  }

  function paginatedCursor(data) {
    if (!paginatedConversationEnvelope(data) || data.page_info.has_previous_page !== true) return null;
    const cursor = typeof data.page_info.start_cursor === "string" ? data.page_info.start_cursor.trim() : "";
    return cursor || null;
  }

  function messageRole(message) {
    return message && message.author ? message.author.role : undefined;
  }

  function messageHidden(message) {
    const metadata = message && message.metadata;
    return !!(metadata && (
      metadata.is_visually_hidden_from_conversation === true ||
      metadata.is_user_system_message === true
    ));
  }

  function messageToolTargeted(message) {
    if (messageRole(message) !== "assistant") return false;
    const recipient = String(message && message.recipient || "").trim().toLowerCase();
    return !!recipient && recipient !== "all" && recipient !== "assistant";
  }

  function messageText(message) {
    const content = message && message.content;
    if (!content) return "";
    if (typeof content === "string") return content;
    if (typeof content.text === "string") return content.text;
    if (!Array.isArray(content.parts)) return "";
    const parts = [];
    for (const part of content.parts) {
      if (typeof part === "string") parts.push(part);
      else if (part && typeof part === "object") {
        if (typeof part.text === "string") parts.push(part.text);
        else if (typeof part.content === "string") parts.push(part.content);
        else if (part.asset_pointer || part.image_url || part.content_type === "image_asset_pointer") parts.push("[Image / attachment]");
        else if (part.content_type) parts.push(`[${part.content_type}]`);
      }
    }
    return parts.join("\n").trim();
  }

  function paginatedVisibleHistory(data) {
    if (!paginatedConversationEnvelope(data)) return [];
    const messages = [];
    for (let index = 0; index < data.messages.length; index++) {
      const message = data.messages[index];
      const role = messageRole(message);
      if ((role !== "user" && role !== "assistant") || messageHidden(message) || messageToolTargeted(message)) continue;
      messages.push({
        id: message && message.id ? message.id : `paginated-message-${index}`,
        role,
        text: messageText(message),
        createTime: message && message.create_time ? message.create_time : null
      });
    }
    return messages;
  }

  function paginatedGraph(data, conversationId) {
    const mapping = Object.create(null);
    const orderedIds = [];
    for (const message of data.messages || []) {
      const id = String(message && message.id || "").trim();
      if (!id || mapping[id]) continue;
      orderedIds.push(id);
      mapping[id] = { id, message, parent: null, children: [] };
    }
    for (let index = 0; index < orderedIds.length; index++) {
      const id = orderedIds[index];
      mapping[id].parent = index > 0 ? orderedIds[index - 1] : null;
      mapping[id].children = index + 1 < orderedIds.length ? [orderedIds[index + 1]] : [];
    }
    const requestedCurrent = String(data.current_node || "").trim();
    const currentNode = requestedCurrent && mapping[requestedCurrent]
      ? requestedCurrent
      : orderedIds[orderedIds.length - 1] || null;
    return {
      ...data,
      id: data.id || data.conversation_id || conversationId,
      conversation_id: data.conversation_id || data.id || conversationId,
      mapping,
      current_node: currentNode
    };
  }

  function activeMessagesFromGraph(data) {
    const mapping = data && data.mapping;
    let id = data && data.current_node;
    if (!mapping || !id || !mapping[id]) return [];
    const reversed = [];
    const seen = new Set();
    while (id && mapping[id] && !seen.has(id)) {
      seen.add(id);
      const node = mapping[id];
      if (node.message) reversed.push(node.message);
      id = node.parent || null;
    }
    reversed.reverse();
    return reversed;
  }

  function transformPaginatedConversation(data, conversationId, mode, limit) {
    const pageInfo = data.page_info || {};
    const hadOlderPages = pageInfo.has_previous_page === true || !!paginatedCursor(data);
    const graph = paginatedGraph(data, conversationId);
    const trimmed = graph.current_node
      ? CGTrim.trimConversation(graph, { mode, maxDisplayMessages: limit })
      : { changed: false, data: graph, reason: "below-limit", stats: {} };
    const keptMessages = activeMessagesFromGraph(trimmed.data);
    const rawMessagesChanged = keptMessages.length !== data.messages.length || !!trimmed.changed;
    const changed = rawMessagesChanged;
    const transformedData = changed
      ? {
          ...data,
          messages: keptMessages,
          current_node: trimmed.data.current_node || data.current_node
        }
      : data;
    const renderedBefore = paginatedVisibleHistory(data).length;
    const renderedAfter = paginatedVisibleHistory({ ...data, messages: keptMessages }).length;
    return {
      changed,
      data: transformedData,
      reason: changed ? "trimmed" : "below-limit",
      stats: {
        ...(trimmed.stats || {}),
        trimMode: mode,
        mappingNodesBefore: Math.max(0, Number(trimmed.stats?.mappingNodesBefore) || data.messages.length),
        mappingNodesAfter: Math.max(0, Number(trimmed.stats?.mappingNodesAfter) || keptMessages.length),
        discardedNodes: Math.max(0, data.messages.length - keptMessages.length),
        displayBefore: renderedBefore,
        displayAfter: renderedAfter,
        logicalDisplayAfter: Number.isFinite(Number(trimmed.stats?.logicalDisplayAfter))
          ? Number(trimmed.stats.logicalDisplayAfter)
          : renderedAfter,
        currentNodePreserved: (trimmed.data.current_node || data.current_node) === data.current_node,
        paginationFirewall: true,
        paginationCursorSuppressed: false,
        paginationCursorPreserved: hadOlderPages,
        paginatedConversationEnvelope: true,
        paginatedMessages: data.messages.length,
        paginatedMessagesAfter: keptMessages.length
      }
    };
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
    const mappingSupported = !!(mappingObject && currentNode && mapping[currentNode]);
    const paginatedSupported = paginatedConversationEnvelope(record);
    const supported = mappingSupported || paginatedSupported;
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
      shapeCurrentNodePresent: mappingSupported,
      shapePaginatedMessages: paginatedSupported,
      shapeMessageCount: paginatedSupported ? record.messages.length : null
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
    return !!(ENDPOINT && typeof ENDPOINT.isConversationDocument === "function" && ENDPOINT.isConversationDocument(urlString, location.href));
  }

  function isConversationMessagesPage(urlString) {
    return !!(ENDPOINT && typeof ENDPOINT.isConversationMessagesPage === "function" && ENDPOINT.isConversationMessagesPage(urlString, location.href));
  }

  function conversationIdFromEndpoint(urlString) {
    if (!ENDPOINT) return null;
    const documentId = typeof ENDPOINT.conversationId === "function" ? ENDPOINT.conversationId(urlString, location.href) : null;
    if (documentId) return documentId;
    return typeof ENDPOINT.messagesPageConversationId === "function"
      ? ENDPOINT.messagesPageConversationId(urlString, location.href)
      : null;
  }

  function transientArchiveFromConversation(data, endpointUrl) {
    if (!globalThis.CGTrim || typeof globalThis.CGTrim.extractVisibleHistory !== "function") return null;
    const id = String(
      data?.id || data?.conversation_id || conversationIdFromEndpoint(endpointUrl) || ""
    ).trim();
    if (!id) return null;
    const paginated = paginatedConversationEnvelope(data);
    const messages = (paginated ? paginatedVisibleHistory(data) : globalThis.CGTrim.extractVisibleHistory(data)).map((message, index) => ({
      id: message.id || `message-${index}`,
      role: message.role,
      text: typeof message.text === "string" ? message.text : String(message.text || ""),
      createTime: message.createTime == null ? null : message.createTime
    }));
    const cursor = paginated
      ? paginatedCursor(data)
      : (typeof data?.cursor === "string" && data.cursor.trim() ? data.cursor.trim() : null);
    return {
      schemaVersion: 1,
      id,
      title: typeof data?.title === "string" && data.title.trim() ? data.title.trim() : "ChatGPT conversation",
      sourceUrl: `${location.origin}/c/${encodeURIComponent(id)}`,
      updatedAt: new Date().toISOString(),
      complete: !cursor,
      paginationCursor: cursor,
      messages
    };
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
      const archive = transientArchiveFromConversation(data, endpointUrl);
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
    const cursorRequest = !!trace.paginationRequest;

    if (paginatedConversationEnvelope(data)) {
      if (cursorRequest) {
        const transformed = {
          changed: true,
          data: {
            ...data,
            messages: [],
            page_info: { ...(data.page_info || {}), has_previous_page: false, start_cursor: null }
          },
          reason: "trimmed",
          stats: {
            trimMode: resolveMode(settings.mode),
            mappingNodesBefore: data.messages.length,
            mappingNodesAfter: 0,
            discardedNodes: data.messages.length,
            displayBefore: paginatedVisibleHistory(data).length,
            displayAfter: 0,
            logicalDisplayAfter: 0,
            currentNodePreserved: true,
            paginationFirewall: true,
            paginationOlderPageBlocked: true,
            paginationCursorSuppressed: true,
            paginationBlockedNodes: data.messages.length,
            paginatedConversationEnvelope: true,
            paginatedMessages: data.messages.length,
            paginatedMessagesAfter: 0
          }
        };
        publishTransformStats(transformed, originalBytes, started, trace);
        return transformed.data;
      }
      const transformed = transformPaginatedConversation(
        data,
        trace.conversationId || conversationIdFromEndpoint(trace.endpointUrl || ""),
        resolveMode(settings.mode),
        normalizeMessageLimit(settings.maxDisplayMessages)
      );
      publishTransformStats(transformed, originalBytes, started, trace);
      return transformed.changed ? transformed.data : data;
    }

    if (cursorRequest && PAGINATION && typeof PAGINATION.apply === "function") {
      const blocked = PAGINATION.apply(data, { cursorRequest: true });
      if (blocked.changed) {
        const transformed = { changed: true, data: blocked.data, reason: "trimmed", stats: {
          trimMode: resolveMode(settings.mode),
          displayBefore: 0,
          displayAfter: 0,
          logicalDisplayAfter: 0,
          ...blocked.stats
        } };
        publishTransformStats(transformed, originalBytes, started, trace);
        return transformed.data;
      }
    }

    const trimmed = CGTrim.trimConversation(data, {
      mode: resolveMode(settings.mode),
      maxDisplayMessages: normalizeMessageLimit(settings.maxDisplayMessages)
    });
    let transformed = trimmed;

    if (PAGINATION && typeof PAGINATION.apply === "function") {
      const firewalled = PAGINATION.apply(trimmed.data, { cursorRequest: false });
      if (firewalled.changed) {
        transformed = {
          changed: true,
          data: firewalled.data,
          reason: "trimmed",
          stats: { ...(trimmed.stats || {}), ...firewalled.stats }
        };
      }
    }

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
    if (!isConversationDocument(response.url) && !isConversationMessagesPage(response.url)) return readBody();

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
    const paginationRequest = !!(PAGINATION && typeof PAGINATION.isCursorRequest === "function" && PAGINATION.isCursorRequest(endpointUrl));
    const trace = {
      ...meta,
      safetyWaitMs,
      responseReadMs,
      paginationRequest,
      ...(decoded.trace || {}),
      ...(paginationRequest ? { archiveOk: false, archiveSkipped: "pagination-page" } : publishArchive(data, endpointUrl))
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
