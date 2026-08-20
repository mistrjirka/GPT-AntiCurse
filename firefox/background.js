/*
 * Firefox network interception and extension state.
 *
 * Firefox exposes webRequest.filterResponseData(), so the full conversation is
 * captured before ChatGPT page code sees the graph. Manifest V3 background
 * scripts are nonpersistent event pages, so durable/session state is never
 * assumed to survive in globals across wakeups.
 */
"use strict";

const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "recent",
  maxDisplayMessages: 64,
  showGuardNotice: true
};
const EMPTY_TOTALS = Object.freeze({
  responsesTrimmed: 0,
  nodesRemoved: 0,
  nodesDelivered: 0,
  visibleTurnsKept: 0,
  inputBytes: 0,
  outputBytes: 0,
  bytesRemoved: 0
});
const LIMITED_MODES = new Set(["recent", "windowed-visible"]);
const DIAGNOSTICS = globalThis.CGAntiCurseDiagnostics;
const STATS_KEY_PREFIX = "cg-tab-stats:";
const HISTORY_KEY_PREFIX = "cg-tab-history:";
const BACKGROUND_STARTED_AT = new Date().toISOString();
const EXPORT_HEADER_NAME = "x-gpt-anticurse-export";
const EXPORT_CONFIRM_HEADER_NAME = "x-gpt-anticurse-export-bypassed";
const EXPORT_BYPASS_TTL_MS = 10000;
const responseFilterStates = new Map();
const exportBypassTokens = new Map();
let exportBypassDisconnects = 0;
let invalidExportBypassMarkers = 0;

let settings = { ...DEFAULT_SETTINGS };
let totals = { ...EMPTY_TOTALS };
let settingsInitialized = false;
let initializationFailed = false;
let pendingSettingChanges = Object.create(null);
let pendingTotalsChange = null;
let counterQueue = Promise.resolve();
// Per-tab UI state is always coupled to the response start time and explicit
// conversation id. A late request may finish, but it cannot replace newer state.
const lastStatsByTab = new Map();
const historyByTab = new Map();
const sessionWriteQueues = new Map();

function recordIssue(scope, code, error, extra) {
  if (DIAGNOSTICS && typeof DIAGNOSTICS.record === "function") return DIAGNOSTICS.record(scope, code, error, extra);
  console.warn(`[GPT AntiCurse] ${scope}/${code}`, error, extra || "");
  return Promise.resolve(null);
}

function normalizeTotals(value) {
  const normalized = { ...EMPTY_TOTALS };
  if (!value || typeof value !== "object") return normalized;
  for (const key of Object.keys(normalized)) {
    const number = Number(value[key]);
    if (Number.isFinite(number) && number >= 0) normalized[key] = number;
  }
  return normalized;
}

function normalizeMessageLimit(value) {
  const number = Number(value);
  return Math.max(4, Math.min(500, Number.isFinite(number) ? number : 64));
}

function resolveMode(value) {
  return LIMITED_MODES.has(value) ? value : "recent";
}

function applySettingChanges(target, changes) {
  const next = { ...target };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) next[key] = changes[key];
  }
  next.mode = resolveMode(next.mode);
  next.maxDisplayMessages = normalizeMessageLimit(next.maxDisplayMessages);
  return next;
}

const settingsReady = browser.storage.local.get({ ...DEFAULT_SETTINGS, cgTotals: EMPTY_TOTALS }).then((saved) => {
  settings = applySettingChanges({ ...DEFAULT_SETTINGS, ...saved }, pendingSettingChanges);
  totals = normalizeTotals(pendingTotalsChange == null ? saved.cgTotals : pendingTotalsChange);
  pendingSettingChanges = Object.create(null);
  pendingTotalsChange = null;
  settingsInitialized = true;
  return true;
}).catch((error) => {
  initializationFailed = true;
  settingsInitialized = true;
  settings = { ...DEFAULT_SETTINGS };
  totals = { ...EMPTY_TOTALS };
  recordIssue("settings", "firefox-storage-read-failed", error);
  return false;
});

function conversationIdFromEndpoint(urlString) {
  try {
    const url = new URL(urlString);
    const match = url.pathname.match(/^\/backend-api\/conversation\/([^/]+)\/?$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch (_) {
    return null;
  }
}

function isConversationDocument(urlString) {
  return !!conversationIdFromEndpoint(urlString);
}

function removedNodeCount(stats) {
  const before = Math.max(0, Number(stats.mappingNodesBefore) || 0);
  const after = Math.max(0, Number(stats.mappingNodesAfter) || 0);
  return Math.max(0, Number(stats.discardedNodes) || before - after);
}

function percentRemoved(stats) {
  const before = Math.max(0, Number(stats.mappingNodesBefore) || 0);
  return before > 0 ? (removedNodeCount(stats) / before) * 100 : 0;
}

function sessionKey(prefix, tabId) {
  return `${prefix}${tabId}`;
}

function cacheSession(prefix, tabId, value, code) {
  if (tabId < 0 || !browser.storage.session) return Promise.resolve(false);
  const key = sessionKey(prefix, tabId);
  const previous = sessionWriteQueues.get(key) || Promise.resolve();
  const operation = previous.catch((error) => {
    console.debug("[GPT AntiCurse] Continuing session cache queue after a failed write", key, error);
  }).then(() => value == null
    ? browser.storage.session.remove(key)
    : browser.storage.session.set({ [key]: value }));
  sessionWriteQueues.set(key, operation);
  const cleanup = () => {
    if (sessionWriteQueues.get(key) === operation) sessionWriteQueues.delete(key);
  };
  operation.then(cleanup, cleanup);
  return operation.then(() => true).catch((error) => {
    recordIssue("session", code, error, { tabId });
    return false;
  });
}

async function readSession(prefix, tabId, code) {
  if (tabId < 0 || !browser.storage.session) return null;
  const key = sessionKey(prefix, tabId);
  const pending = sessionWriteQueues.get(key);
  if (pending) await pending.catch((error) => {
    console.debug("[GPT AntiCurse] Pending session fallback write failed before read", key, error);
  });
  try {
    const saved = await browser.storage.session.get(key);
    return saved && saved[key] != null ? saved[key] : null;
  } catch (error) {
    await recordIssue("session", code, error, { tabId });
    return null;
  }
}

function serializeCounterOperation(operation) {
  const queued = counterQueue.then(operation);
  counterQueue = queued.catch((error) => {
    console.warn("[GPT AntiCurse] Counter queue recovered after a failed operation", error);
  });
  return queued;
}

function updateTotals(stats) {
  if (!stats || stats.mode !== "trimmed") return Promise.resolve({ ...totals });
  return serializeCounterOperation(async () => {
    const after = Math.max(0, Number(stats.mappingNodesAfter) || 0);
    const inputBytes = Math.max(0, Number(stats.originalBytes) || 0);
    const outputBytes = Math.max(0, Number(stats.outputBytes) || 0);
    const bytesRemoved = inputBytes && outputBytes ? Math.max(0, inputBytes - outputBytes) : 0;
    totals = {
      responsesTrimmed: totals.responsesTrimmed + 1,
      nodesRemoved: totals.nodesRemoved + removedNodeCount(stats),
      nodesDelivered: totals.nodesDelivered + after,
      visibleTurnsKept: totals.visibleTurnsKept + Math.max(0, Number(stats.displayAfter) || 0),
      inputBytes: totals.inputBytes + inputBytes,
      outputBytes: totals.outputBytes + outputBytes,
      bytesRemoved: totals.bytesRemoved + bytesRemoved
    };
    const snapshot = { ...totals };
    await browser.storage.local.set({ cgTotals: snapshot });
    return snapshot;
  });
}

function resetTotals() {
  return serializeCounterOperation(async () => {
    totals = { ...EMPTY_TOTALS };
    const snapshot = { ...totals };
    await browser.storage.local.set({ cgTotals: snapshot });
    return snapshot;
  });
}

function updateActionBadge(tabId, stats) {
  if (tabId < 0) return;
  const saved = Math.round(Math.max(0, Math.min(100, percentRemoved(stats))));
  const badge = stats.mode === "trimmed" ? `${saved}%` : stats.mode === "error" ? "ERR" : "OK";
  const title = stats.mode === "trimmed"
    ? `GPT AntiCurse: removed ${removedNodeCount(stats)} of ${stats.mappingNodesBefore} mapping nodes; kept ${stats.displayAfter} visible turns`
    : stats.mode === "error"
      ? `GPT AntiCurse error: original response passed through (${stats.error || stats.reason || "unknown"})`
      : "GPT AntiCurse: response unchanged";
  browser.action.setBadgeText({ tabId, text: badge }).catch((error) => console.debug("[GPT AntiCurse] Badge update skipped", error));
  browser.action.setTitle({ tabId, title }).catch((error) => console.debug("[GPT AntiCurse] Badge title update skipped", error));
}

function statsForRequest(details, stats, conversationId = null) {
  return {
    ...stats,
    conversationId: conversationId || conversationIdFromEndpoint(details && details.url) || null
  };
}

function publishStats(tabId, rawStats, requestStartedAt) {
  if (tabId < 0) return false;
  const stats = rawStats || {};
  // Cumulative totals describe real completed optimization work, not whichever
  // response currently owns the tab UI. Count it even if a newer SPA response
  // makes this status too old to publish.
  updateTotals(stats).catch((error) => recordIssue("counters", "firefox-persist-failed", error));

  const startedAt = Number(requestStartedAt) || 0;
  const previous = lastStatsByTab.get(tabId);
  if (previous && previous.requestStartedAt > startedAt) return false;

  lastStatsByTab.set(tabId, { requestStartedAt: startedAt, stats });
  cacheSession(STATS_KEY_PREFIX, tabId, stats, "stats-cache-write-failed");
  updateActionBadge(tabId, stats);
  browser.tabs.sendMessage(tabId, { type: "cg-stats", stats })
    .catch((error) => console.debug("[GPT AntiCurse] Early stats delivery skipped", error));
  return true;
}

function publishConversationScope(tabId, conversationId) {
  if (tabId < 0 || !conversationId) return;
  browser.tabs.sendMessage(tabId, { type: "cg-conversation-scope", conversationId })
    .catch((error) => console.debug("[GPT AntiCurse] Early conversation-scope delivery skipped", error));
}

function publishHistory(tabId, history, requestStartedAt) {
  if (tabId < 0) return false;
  const startedAt = Number(requestStartedAt) || 0;
  const previous = historyByTab.get(tabId);
  if (previous && previous.requestStartedAt > startedAt) return false;

  if (history) historyByTab.set(tabId, { requestStartedAt: startedAt, history });
  else historyByTab.delete(tabId);

  if (!history) {
    cacheSession(HISTORY_KEY_PREFIX, tabId, null, "history-cache-remove-failed");
    return true;
  }

  browser.tabs.sendMessage(tabId, { type: "cg-window-history", history }).then(() => {
    cacheSession(HISTORY_KEY_PREFIX, tabId, null, "history-cache-remove-failed");
  }).catch((error) => {
    console.debug("[GPT AntiCurse] Early history delivery skipped; caching session fallback", error);
    cacheSession(HISTORY_KEY_PREFIX, tabId, history, "history-cache-write-failed");
  });
  return true;
}

function buildHistoryArchive(parsed, transformed, mode, limit, conversationId) {
  if (!LIMITED_MODES.has(mode) || !conversationId) return null;
  const messages = CGTrim.extractVisibleHistory(parsed);
  const fallbackNativeCount = Math.min(messages.length, limit);
  const nativeVisibleCount = transformed.stats && Number.isFinite(Number(transformed.stats.displayAfter))
    ? Math.max(0, Number(transformed.stats.displayAfter))
    : fallbackNativeCount;
  return {
    ok: true,
    conversationId,
    messages,
    nativeVisibleCount,
    pageSize: limit,
    maxRendered: Math.max(limit, Math.min(500, limit * 3)),
    source: "firefox-network-filter"
  };
}

function transformConversation(parsed, conversationId) {
  const mode = resolveMode(settings.mode);
  const limit = normalizeMessageLimit(settings.maxDisplayMessages);
  const transformed = CGTrim.trimConversation(parsed, { mode, maxDisplayMessages: limit });
  return { mode, transformed, history: buildHistoryArchive(parsed, transformed, mode, limit, conversationId) };
}


function copyChunk(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function concatChunks(chunks, totalBytes) {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function decodeJson(chunks, totalBytes) {
  let text = new TextDecoder("utf-8").decode(concatChunks(chunks, totalBytes));
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

function writeOriginal(filter, chunks) {
  for (const chunk of chunks) filter.write(chunk);
}

function publishPassthroughStats(details, transformed, totalBytes, started, conversationId = null) {
  if (transformed.reason === "unsupported-shape") {
    const message = "Unsupported ChatGPT conversation response shape; original response kept.";
    recordIssue("interceptor", "unsupported-conversation-shape", message);
    publishStats(details.tabId, statsForRequest(details, {
      mode: "error",
      transport: "firefox-stream-filter",
      reason: transformed.reason,
      error: message,
      originalBytes: totalBytes,
      processingMs: +(performance.now() - started).toFixed(2)
    }, conversationId), details.timeStamp);
    return;
  }
  publishStats(details.tabId, statsForRequest(details, {
    mode: "passthrough",
    transport: "firefox-stream-filter",
    reason: transformed.reason,
    originalBytes: totalBytes,
    processingMs: +(performance.now() - started).toFixed(2),
    ...(transformed.stats || {})
  }, conversationId), details.timeStamp);
}

function writeTransformedResponse(filter, details, transformed, totalBytes, started, conversationId = null) {
  const output = new TextEncoder().encode(JSON.stringify(transformed.data));
  filter.write(output);
  publishStats(details.tabId, statsForRequest(details, {
    mode: "trimmed",
    transport: "firefox-stream-filter",
    originalBytes: totalBytes,
    outputBytes: output.byteLength,
    processingMs: +(performance.now() - started).toFixed(2),
    ...transformed.stats
  }, conversationId), details.timeStamp);
}

function exportBypassToken() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    const bytes = new Uint32Array(4);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(8, "0")).join("");
  }
  return null;
}

function cleanupExportBypassTokens(now = Date.now()) {
  for (const [token, value] of exportBypassTokens) {
    if (!value || value.expiresAt <= now) exportBypassTokens.delete(token);
  }
}

function createExportBypass(sender, conversationId) {
  const tabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : -1;
  if (tabId < 0 || !conversationId) return { ok: false, reason: "invalid-export-bypass-request" };
  cleanupExportBypassTokens();
  const token = exportBypassToken();
  if (!token) return { ok: false, reason: "secure-random-unavailable" };
  exportBypassTokens.set(token, {
    tabId,
    conversationId: String(conversationId),
    expiresAt: Date.now() + EXPORT_BYPASS_TTL_MS
  });
  return { ok: true, token, expiresInMs: EXPORT_BYPASS_TTL_MS };
}

function stripExportRequestMarker(details) {
  const headers = Array.isArray(details && details.requestHeaders) ? details.requestHeaders : [];
  let suppliedToken = "";
  const requestHeaders = [];
  for (const header of headers) {
    if (String(header && header.name || "").toLowerCase() === EXPORT_HEADER_NAME) {
      suppliedToken = String(header && header.value || "");
      continue;
    }
    requestHeaders.push(header);
  }
  if (!suppliedToken) return {};

  cleanupExportBypassTokens();
  const grant = exportBypassTokens.get(suppliedToken);
  const conversationId = conversationIdFromEndpoint(details && details.url);
  const valid = !!grant &&
    grant.expiresAt > Date.now() &&
    grant.tabId === details.tabId &&
    grant.conversationId === conversationId;
  if (grant) exportBypassTokens.delete(suppliedToken);
  if (valid) {
    const state = responseFilterStates.get(details.requestId);
    if (state) state.exportBypass = true;
  } else {
    invalidExportBypassMarkers++;
  }
  // Never leak the private extension marker to ChatGPT, valid or invalid.
  return { requestHeaders };
}

function confirmExportBypassResponse(details) {
  const state = responseFilterStates.get(details && details.requestId);
  const headers = Array.isArray(details && details.responseHeaders) ? details.responseHeaders : [];
  const responseHeaders = headers.filter((header) => String(header && header.name || "").toLowerCase() !== EXPORT_CONFIRM_HEADER_NAME);
  if (!state || !state.exportBypass) return responseHeaders.length === headers.length ? {} : { responseHeaders };
  responseHeaders.push({ name: "X-GPT-AntiCurse-Export-Bypassed", value: "1" });
  return { responseHeaders };
}

async function processResponse(filter, chunks, totalBytes, details, exportBypass = false) {
  const started = performance.now();
  const endpointConversationId = conversationIdFromEndpoint(details.url);
  try {
    if (exportBypass) {
      writeOriginal(filter, chunks);
      return;
    }
    const initialized = await settingsReady;
    if (!initialized || initializationFailed) {
      writeOriginal(filter, chunks);
      publishStats(details.tabId, statsForRequest(details, {
        mode: "error",
        transport: "firefox-stream-filter",
        reason: "settings-unavailable",
        error: "Firefox extension settings could not be read; original response kept.",
        originalBytes: totalBytes,
        processingMs: +(performance.now() - started).toFixed(2)
      }, endpointConversationId), details.timeStamp);
      return;
    }

    if (!settings.enabled) {
      writeOriginal(filter, chunks);
      publishStats(details.tabId, statsForRequest(details, {
        mode: "passthrough",
        transport: "firefox-stream-filter",
        reason: "disabled",
        originalBytes: totalBytes,
        processingMs: +(performance.now() - started).toFixed(2)
      }, endpointConversationId), details.timeStamp);
      return;
    }

    const parsed = decodeJson(chunks, totalBytes);
    const conversationId = endpointConversationId || parsed?.id || parsed?.conversation_id || null;
    publishConversationScope(details.tabId, conversationId);

    if (!settings.enabled) {
      writeOriginal(filter, chunks);
      publishHistory(details.tabId, null, details.timeStamp);
      publishStats(details.tabId, statsForRequest(details, {
        mode: "passthrough",
        transport: "firefox-stream-filter",
        reason: "disabled",
        originalBytes: totalBytes,
        processingMs: +(performance.now() - started).toFixed(2)
      }, conversationId), details.timeStamp);
      return;
    }

    const result = transformConversation(parsed, conversationId);
    publishHistory(details.tabId, result.history, details.timeStamp);
    if (!result.transformed.changed) {
      writeOriginal(filter, chunks);
      publishPassthroughStats(details, result.transformed, totalBytes, started, conversationId);
    } else {
      writeTransformedResponse(filter, details, result.transformed, totalBytes, started, conversationId);
    }
  } catch (error) {
    try {
      writeOriginal(filter, chunks);
    } catch (writeError) {
      console.error("[GPT AntiCurse] Failed to restore the original Firefox response after an interceptor error", writeError);
    }
    recordIssue("interceptor", "firefox-transform-failed", error);
    publishStats(details.tabId, statsForRequest(details, {
      mode: "error",
      transport: "firefox-stream-filter",
      error: String(error && error.message ? error.message : error),
      originalBytes: totalBytes,
      processingMs: +(performance.now() - started).toFixed(2)
    }, endpointConversationId), details.timeStamp);
  } finally {
    try {
      filter.close();
    } catch (closeError) {
      console.debug("[GPT AntiCurse] StreamFilter was already closed", closeError);
    }
  }
}

function interceptConversation(details) {
  if (details.method !== "GET" || !isConversationDocument(details.url)) return {};

  const filter = browser.webRequest.filterResponseData(details.requestId);
  const chunks = [];
  let totalBytes = 0;
  let finished = false;
  const filterState = { exportBypass: false };
  responseFilterStates.set(details.requestId, filterState);

  filter.ondata = (event) => {
    if (filterState.exportBypass && chunks.length === 0) {
      // Pass the first bytes through before disconnecting. This follows the
      // StreamFilter's safe data-path semantics and avoids retaining the full
      // export response in the background on memory-constrained mobile devices.
      finished = true;
      responseFilterStates.delete(details.requestId);
      exportBypassDisconnects++;
      filter.write(event.data);
      filter.disconnect();
      return;
    }
    const chunk = copyChunk(event.data);
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  };
  filter.onstop = () => {
    if (finished) return;
    finished = true;
    responseFilterStates.delete(details.requestId);
    processResponse(filter, chunks, totalBytes, details, filterState.exportBypass).catch((error) => {
      recordIssue("interceptor", "firefox-response-handler-failed", error);
      try {
        writeOriginal(filter, chunks);
        filter.close();
      } catch (recoveryError) {
        console.error("[GPT AntiCurse] Emergency Firefox response recovery failed", recoveryError);
      }
    });
  };
  filter.onerror = () => {
    if (finished) return;
    finished = true;
    responseFilterStates.delete(details.requestId);
    const error = filter.error || "StreamFilter error";
    recordIssue("interceptor", "firefox-stream-filter-error", error);
    publishStats(details.tabId, statsForRequest(details, {
      mode: "error",
      transport: "firefox-stream-filter",
      error
    }), details.timeStamp);
  };
  return {};
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!settingsInitialized) {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (changes[key]) pendingSettingChanges[key] = changes[key].newValue;
    }
    if (changes.cgTotals) pendingTotalsChange = changes.cgTotals.newValue;
    return;
  }
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (changes[key]) settings[key] = changes[key].newValue;
  }
  settings.mode = resolveMode(settings.mode);
  settings.maxDisplayMessages = normalizeMessageLimit(settings.maxDisplayMessages);
  if (changes.cgTotals) totals = normalizeTotals(changes.cgTotals.newValue);
});

browser.webRequest.onBeforeRequest.addListener(
  interceptConversation,
  { urls: ["https://chatgpt.com/backend-api/conversation/*"] },
  ["blocking"]
);

browser.webRequest.onBeforeSendHeaders.addListener(
  stripExportRequestMarker,
  { urls: ["https://chatgpt.com/backend-api/conversation/*"] },
  ["blocking", "requestHeaders"]
);

browser.webRequest.onHeadersReceived.addListener(
  confirmExportBypassResponse,
  { urls: ["https://chatgpt.com/backend-api/conversation/*"] },
  ["blocking", "responseHeaders"]
);

function statsMatchConversation(stats, requestedId) {
  return !requestedId || !stats || !stats.conversationId || stats.conversationId === requestedId;
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message) return undefined;
  if (message.type === "cg-background-health") {
    return Promise.resolve({
      ok: !initializationFailed,
      phase: initializationFailed ? "settings-failed" : settingsInitialized ? "ready" : "initializing",
      startedAt: BACKGROUND_STARTED_AT,
      version: browser.runtime.getManifest().version,
      settingsInitialized,
      initializationFailed,
      hotStatsTabs: lastStatsByTab.size,
      hotHistoryTabs: historyByTab.size,
      sessionWritesPending: sessionWriteQueues.size,
      activeResponseFilters: responseFilterStates.size,
      pendingExportBypasses: exportBypassTokens.size,
      exportBypassDisconnects,
      invalidExportBypassMarkers
    });
  }
  if (message.type === "cg-create-export-bypass") {
    return Promise.resolve(createExportBypass(sender, message.conversationId));
  }
  if (message.type === "cg-get-stats") {
    const tabId = sender.tab ? sender.tab.id : message.tabId;
    const requestedId = message.conversationId || null;
    const hotState = lastStatsByTab.get(tabId);
    const hot = hotState && hotState.stats;
    if (hot && statsMatchConversation(hot, requestedId)) return Promise.resolve(hot);
    return readSession(STATS_KEY_PREFIX, tabId, "stats-cache-read-failed").then((saved) => {
      if (!saved) return null;
      return statsMatchConversation(saved, requestedId) ? saved : null;
    });
  }
  if (message.type === "cg-get-window-history") {
    const tabId = sender.tab ? sender.tab.id : message.tabId;
    const requestedId = message.conversationId;
    if (!requestedId) return Promise.resolve({ ok: false, reason: "missing-conversation-id" });

    const hotState = historyByTab.get(tabId);
    const hot = hotState && hotState.history;
    if (hot && hot.conversationId === requestedId) return Promise.resolve(hot);

    return readSession(HISTORY_KEY_PREFIX, tabId, "history-cache-read-failed").then((saved) => {
      if (!saved) return { ok: false, reason: "archive-not-found" };
      return saved.conversationId === requestedId
        ? saved
        : { ok: false, reason: "conversation-mismatch", conversationId: saved.conversationId };
    });
  }
  if (message.type === "cg-get-totals") {
    return settingsReady.then(() => counterQueue.then(() => ({ ...totals })));
  }
  if (message.type === "cg-reset-totals") {
    return settingsReady.then(resetTotals);
  }
  if (message.type === "cg-settings") {
    return settingsReady.then(() => {
      const next = {};
      if (typeof message.enabled === "boolean") next.enabled = message.enabled;
      if (LIMITED_MODES.has(message.mode)) next.mode = message.mode;
      if (Number.isFinite(Number(message.maxDisplayMessages))) next.maxDisplayMessages = normalizeMessageLimit(message.maxDisplayMessages);
      if (typeof message.showGuardNotice === "boolean") next.showGuardNotice = message.showGuardNotice;
      return browser.storage.local.set(next).then(() => {
        settings = applySettingChanges(settings, next);
        return settings;
      });
    });
  }
  return undefined;
});

browser.tabs.onRemoved.addListener((tabId) => {
  lastStatsByTab.delete(tabId);
  for (const [token, grant] of exportBypassTokens) if (grant && grant.tabId === tabId) exportBypassTokens.delete(token);
  historyByTab.delete(tabId);
  sessionWriteQueues.delete(sessionKey(STATS_KEY_PREFIX, tabId));
  sessionWriteQueues.delete(sessionKey(HISTORY_KEY_PREFIX, tabId));
  if (browser.storage.session) {
    browser.storage.session.remove([
      sessionKey(STATS_KEY_PREFIX, tabId),
      sessionKey(HISTORY_KEY_PREFIX, tabId)
    ]).catch((error) => console.debug("[GPT AntiCurse] Session cleanup skipped", error));
  }
});