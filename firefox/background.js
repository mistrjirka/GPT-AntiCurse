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
  showGuardNotice: true,
  stallRecoveryEnabled: true
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
const PAGINATION = globalThis.CGPaginationFirewall;
const ENDPOINT = globalThis.CGConversationEndpoint;
const STATS_KEY_PREFIX = "cg-tab-stats:";
const HISTORY_KEY_PREFIX = "cg-tab-history:";
const BACKGROUND_STARTED_AT = new Date().toISOString();
const EXPORT_HEADER_NAME = "x-gpt-anticurse-export";
const EXPORT_CONFIRM_HEADER_NAME = "x-gpt-anticurse-export-bypassed";
const EXPORT_BYPASS_TTL_MS = 10000;
const responseFilterStates = new Map();
const exportBypassTokens = new Map();
const standaloneExportBypassRequests = new Map();
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
  if (!ENDPOINT || typeof ENDPOINT.conversationId !== "function") return null;
  return ENDPOINT.conversationId(urlString);
}

function isConversationDocument(urlString) {
  return !!conversationIdFromEndpoint(urlString);
}

function exportConversationIdFromUrl(urlString) {
  const exact = conversationIdFromEndpoint(urlString);
  if (exact) return exact;
  try {
    const url = new URL(urlString);
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") return null;
    const match = url.pathname.match(/^\/backend-api\/conversations\/([^/]+)\/messages\/?$/);
    if (!match) return null;
    const id = decodeURIComponent(match[1]).trim();
    return id || null;
  } catch (_) {
    return null;
  }
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
  // A native older cursor request may have been queued before the newest page
  // was firewalled. Its empty response must never replace the current-page
  // stats/history state when that older request finishes later.
  if (stats.paginationOlderPageBlocked) return false;
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
  if (!paginatedConversationEnvelope(data)) return null;
  const pageInfo = data.page_info || {};
  if (pageInfo.has_previous_page !== true) return null;
  const cursor = typeof pageInfo.start_cursor === "string" ? pageInfo.start_cursor.trim() : "";
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
    if ((role !== "user" && role !== "assistant") || messageHidden(message)) continue;
    messages.push({
      id: message && message.id ? message.id : `paginated-message-${index}`,
      role,
      text: messageText(message),
      createTime: message && message.create_time ? message.create_time : null
    });
  }
  return messages;
}

function buildPaginatedHistoryArchive(parsed, mode, limit, conversationId) {
  if (!LIMITED_MODES.has(mode) || !conversationId || !paginatedConversationEnvelope(parsed)) return null;
  // When the server says older pages exist, do not pretend this newest page is a
  // complete archive. The isolated authoritative-history path will fetch the full
  // graph after the native page has been safely bounded.
  if (parsed.page_info?.has_previous_page === true || paginatedCursor(parsed)) return null;
  const messages = paginatedVisibleHistory(parsed);
  return {
    ok: true,
    conversationId,
    messages,
    nativeVisibleCount: messages.length,
    pageSize: limit,
    maxRendered: Math.max(limit, Math.min(500, limit * 3)),
    source: "firefox-network-filter-paginated"
  };
}

function transformPaginatedConversation(parsed, conversationId, mode, limit) {
  const pageInfo = parsed.page_info || {};
  const hadOlderPages = pageInfo.has_previous_page === true || !!paginatedCursor(parsed);
  const messages = paginatedVisibleHistory(parsed);
  const nodeCount = Math.max(1, parsed.messages.length + 1); // ChatGPT adds one synthetic paginated root.
  const data = hadOlderPages
    ? {
        ...parsed,
        page_info: {
          ...pageInfo,
          has_previous_page: false,
          start_cursor: null
        }
      }
    : parsed;
  const stats = {
    trimMode: mode,
    mappingNodesBefore: nodeCount,
    activePathNodesBefore: nodeCount,
    mappingNodesAfter: nodeCount,
    discardedNodes: 0,
    displayBefore: messages.length,
    displayAfter: messages.length,
    logicalDisplayAfter: messages.length,
    currentNodePreserved: true,
    paginationFirewall: true,
    paginationCursorSuppressed: hadOlderPages,
    paginatedConversationEnvelope: true,
    paginatedMessages: parsed.messages.length
  };
  return {
    mode,
    transformed: {
      changed: hadOlderPages,
      data,
      reason: hadOlderPages ? "trimmed" : "below-limit",
      stats
    },
    history: buildPaginatedHistoryArchive(parsed, mode, limit, conversationId)
  };
}

function buildHistoryArchive(parsed, transformed, mode, limit, conversationId) {
  if (!LIMITED_MODES.has(mode) || !conversationId) return null;
  if (typeof parsed?.cursor === "string" && parsed.cursor.trim()) return null;
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

function transformConversation(parsed, conversationId, cursorRequest = false) {
  const mode = resolveMode(settings.mode);
  const limit = normalizeMessageLimit(settings.maxDisplayMessages);

  // ChatGPT's current plural endpoint returns a raw paginated envelope
  // { messages, page_info, current_node, ... }. The page converts that envelope
  // to a mapping only *after* Response.json() resolves. Preserve that API shape
  // and only terminate native older-page pagination; AntiCurse owns older history
  // through its isolated authenticated path.
  if (paginatedConversationEnvelope(parsed)) {
    return transformPaginatedConversation(parsed, conversationId, mode, limit);
  }

  if (cursorRequest && PAGINATION && typeof PAGINATION.apply === "function") {
    const blocked = PAGINATION.apply(parsed, { cursorRequest: true });
    if (blocked.changed) {
      return {
        mode,
        transformed: {
          changed: true,
          data: blocked.data,
          reason: "trimmed",
          stats: { trimMode: mode, displayBefore: 0, displayAfter: 0, logicalDisplayAfter: 0, ...blocked.stats }
        },
        history: null
      };
    }
  }

  const trimmed = CGTrim.trimConversation(parsed, { mode, maxDisplayMessages: limit });
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
  return {
    mode,
    transformed,
    history: cursorRequest ? null : buildHistoryArchive(parsed, transformed, mode, limit, conversationId)
  };
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
  for (const [requestId, value] of standaloneExportBypassRequests) {
    if (!value || value.expiresAt <= now) standaloneExportBypassRequests.delete(requestId);
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
  const conversationId = exportConversationIdFromUrl(details && details.url);
  const valid = !!grant &&
    grant.expiresAt > Date.now() &&
    grant.tabId === details.tabId &&
    grant.conversationId === conversationId;
  if (grant) exportBypassTokens.delete(suppliedToken);
  if (valid) {
    const state = responseFilterStates.get(details.requestId);
    if (state) {
      state.exportBypass = true;
    } else {
      // `/conversations/<id>/messages` is intentionally not a normal AntiCurse
      // interception target. For a validated private history fetch we only strip
      // the one-shot marker and confirm the bypass back to the content script.
      standaloneExportBypassRequests.set(details.requestId, {
        tabId: details.tabId,
        expiresAt: Date.now() + EXPORT_BYPASS_TTL_MS
      });
    }
  } else {
    invalidExportBypassMarkers++;
  }
  // Never leak the private extension marker to ChatGPT, valid or invalid.
  return { requestHeaders };
}

function confirmExportBypassResponse(details) {
  cleanupExportBypassTokens();
  const state = responseFilterStates.get(details && details.requestId);
  const standalone = standaloneExportBypassRequests.get(details && details.requestId);
  if (standalone) standaloneExportBypassRequests.delete(details.requestId);
  const headers = Array.isArray(details && details.responseHeaders) ? details.responseHeaders : [];
  const responseHeaders = headers.filter((header) => String(header && header.name || "").toLowerCase() !== EXPORT_CONFIRM_HEADER_NAME);
  if (!(state && state.exportBypass) && !standalone) {
    return responseHeaders.length === headers.length ? {} : { responseHeaders };
  }
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

    const cursorRequest = !!(PAGINATION && typeof PAGINATION.isCursorRequest === "function" && PAGINATION.isCursorRequest(details.url));
    const result = transformConversation(parsed, conversationId, cursorRequest);
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
  { urls: ["https://chatgpt.com/backend-api/conversation/*", "https://chatgpt.com/backend-api/conversations/*"] },
  ["blocking"]
);

browser.webRequest.onBeforeSendHeaders.addListener(
  stripExportRequestMarker,
  { urls: ["https://chatgpt.com/backend-api/conversation/*", "https://chatgpt.com/backend-api/conversations/*"] },
  ["blocking", "requestHeaders"]
);

browser.webRequest.onHeadersReceived.addListener(
  confirmExportBypassResponse,
  { urls: ["https://chatgpt.com/backend-api/conversation/*", "https://chatgpt.com/backend-api/conversations/*"] },
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
      pendingStandaloneExportBypasses: standaloneExportBypassRequests.size,
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
      if (typeof message.stallRecoveryEnabled === "boolean") next.stallRecoveryEnabled = message.stallRecoveryEnabled;
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
  for (const [requestId, grant] of standaloneExportBypassRequests) if (grant && grant.tabId === tabId) standaloneExportBypassRequests.delete(requestId);
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