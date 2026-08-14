/*
 * Firefox network interception and extension state.
 *
 * Firefox exposes webRequest.filterResponseData(), so the full conversation is
 * captured before ChatGPT page code sees the graph. Parsing/transformation
 * failures are fail-open: the untouched response is written back and an explicit
 * local diagnostic is recorded.
 */
"use strict";

const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "recent",
  maxDisplayMessages: 64,
  showGuardNotice: true,
  archiveEnabled: true
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

// Backup persistence fails private until storage confirms the setting. Graph
// trimming itself still starts with the bounded product defaults immediately.
let settings = { ...DEFAULT_SETTINGS, archiveEnabled: false };
let totals = { ...EMPTY_TOTALS };
const lastStatsByTab = new Map();
const historyByTab = new Map();

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

function isConversationDocument(urlString) {
  try {
    return /^\/backend-api\/conversation\/[^/]+\/?$/.test(new URL(urlString).pathname);
  } catch (_) {
    return false;
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

function recordTotals(stats) {
  if (!stats || stats.mode !== "trimmed") return stats;
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
  browser.storage.local.set({ cgTotals: totals }).catch((error) => {
    // Counters are optional and never affect interception/history correctness.
    console.warn("[GPT AntiCurse] Failed to persist local counters", error);
  });
  return { ...stats, totals: { ...totals } };
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
  // Tab closure/navigation can race these cosmetic calls; failure is harmless.
  browser.action.setBadgeText({ tabId, text: badge }).catch((error) => console.debug("[GPT AntiCurse] Badge update skipped", error));
  browser.action.setTitle({ tabId, title }).catch((error) => console.debug("[GPT AntiCurse] Badge title update skipped", error));
}

function publishStats(tabId, rawStats) {
  if (tabId < 0) return;
  const stats = recordTotals(rawStats);
  lastStatsByTab.set(tabId, stats);
  updateActionBadge(tabId, stats);
  // Content script may not exist yet; cg-get-stats provides a deterministic fallback.
  browser.tabs.sendMessage(tabId, { type: "cg-stats", stats }).catch((error) => console.debug("[GPT AntiCurse] Early stats delivery skipped", error));
}

function publishHistory(tabId, history) {
  if (tabId < 0) return;
  if (history) historyByTab.set(tabId, history);
  else historyByTab.delete(tabId);
  // Content script may not exist yet; cg-get-window-history retrieves retained history later.
  browser.tabs.sendMessage(tabId, { type: "cg-window-history", history }).catch((error) => console.debug("[GPT AntiCurse] Early history delivery skipped", error));
}

function buildHistoryArchive(parsed, transformed, mode, limit) {
  if (!LIMITED_MODES.has(mode)) return null;
  const messages = CGTrim.extractVisibleHistory(parsed);
  const fallbackNativeCount = Math.min(messages.length, limit);
  const nativeVisibleCount = transformed.stats && Number.isFinite(Number(transformed.stats.displayAfter))
    ? Math.max(0, Number(transformed.stats.displayAfter))
    : fallbackNativeCount;
  return {
    ok: true,
    messages,
    nativeVisibleCount,
    pageSize: limit,
    maxRendered: Math.max(limit, Math.min(500, limit * 3)),
    source: "firefox-network-filter"
  };
}

function transformConversation(parsed) {
  const mode = resolveMode(settings.mode);
  const limit = normalizeMessageLimit(settings.maxDisplayMessages);
  const transformed = CGTrim.trimConversation(parsed, { mode, maxDisplayMessages: limit });
  return { mode, transformed, history: buildHistoryArchive(parsed, transformed, mode, limit) };
}

function persistAuthoritativeArchive(parsed, details) {
  if (!settings.archiveEnabled) return;
  let archive;
  try {
    archive = CGArchive.createArchive(parsed, { endpointUrl: details.url });
  } catch (error) {
    recordIssue("archive", "network-archive-build-failed", error);
    return;
  }
  if (!archive) {
    recordIssue("archive", "network-archive-build-empty", "The Firefox network response could not be converted to an archive.");
    return;
  }
  CGArchiveBackground.saveNetworkArchive(archive, details.tabId).then((result) => {
    if (!result || result.ok !== true) recordIssue("archive", "network-persist-rejected", result && result.reason ? result.reason : "Archive write was not confirmed.");
  }).catch((error) => recordIssue("archive", "network-persist-failed", error));
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

function publishPassthroughStats(details, transformed, totalBytes, started) {
  if (transformed.reason === "unsupported-shape") {
    const message = "Unsupported ChatGPT conversation response shape; original response kept.";
    recordIssue("interceptor", "unsupported-conversation-shape", message);
    publishStats(details.tabId, {
      mode: "error",
      transport: "firefox-stream-filter",
      reason: transformed.reason,
      error: message,
      originalBytes: totalBytes,
      processingMs: +(performance.now() - started).toFixed(2)
    });
    return;
  }
  publishStats(details.tabId, {
    mode: "passthrough",
    reason: transformed.reason,
    originalBytes: totalBytes,
    processingMs: +(performance.now() - started).toFixed(2),
    ...(transformed.stats || {})
  });
}

function writeTransformedResponse(filter, details, transformed, totalBytes, started) {
  const output = new TextEncoder().encode(JSON.stringify(transformed.data));
  filter.write(output);
  publishStats(details.tabId, {
    mode: "trimmed",
    transport: "firefox-stream-filter",
    originalBytes: totalBytes,
    outputBytes: output.byteLength,
    processingMs: +(performance.now() - started).toFixed(2),
    ...transformed.stats
  });
}

function processResponse(filter, chunks, totalBytes, details) {
  const started = performance.now();
  try {
    const parsed = decodeJson(chunks, totalBytes);
    persistAuthoritativeArchive(parsed, details);
    const result = transformConversation(parsed);
    publishHistory(details.tabId, result.history);

    if (!result.transformed.changed) {
      writeOriginal(filter, chunks);
      publishPassthroughStats(details, result.transformed, totalBytes, started);
    } else {
      writeTransformedResponse(filter, details, result.transformed, totalBytes, started);
    }
  } catch (error) {
    try {
      writeOriginal(filter, chunks);
    } catch (writeError) {
      console.error("[GPT AntiCurse] Failed to restore the original Firefox response after an interceptor error", writeError);
    }
    recordIssue("interceptor", "firefox-transform-failed", error);
    publishStats(details.tabId, {
      mode: "error",
      transport: "firefox-stream-filter",
      error: String(error && error.message ? error.message : error),
      originalBytes: totalBytes,
      processingMs: +(performance.now() - started).toFixed(2)
    });
  } finally {
    try {
      filter.close();
    } catch (closeError) {
      console.debug("[GPT AntiCurse] StreamFilter was already closed", closeError);
    }
  }
}

function interceptConversation(details) {
  if (!settings.enabled || details.method !== "GET" || !isConversationDocument(details.url)) return {};
  const filter = browser.webRequest.filterResponseData(details.requestId);
  const chunks = [];
  let totalBytes = 0;
  filter.ondata = (event) => {
    const chunk = copyChunk(event.data);
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  };
  filter.onstop = () => processResponse(filter, chunks, totalBytes, details);
  filter.onerror = () => {
    const error = filter.error || "StreamFilter error";
    recordIssue("interceptor", "firefox-stream-filter-error", error);
    publishStats(details.tabId, { mode: "error", transport: "firefox-stream-filter", error });
  };
  return {};
}

browser.storage.local.get({ ...DEFAULT_SETTINGS, cgTotals: EMPTY_TOTALS }).then((saved) => {
  settings = { ...DEFAULT_SETTINGS, ...saved, mode: resolveMode(saved.mode) };
  totals = normalizeTotals(saved.cgTotals);
}).catch((error) => {
  settings = { ...DEFAULT_SETTINGS, archiveEnabled: false };
  recordIssue("settings", "firefox-storage-read-failed", error);
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (changes[key]) settings[key] = changes[key].newValue;
  }
  settings.mode = resolveMode(settings.mode);
  if (changes.cgTotals) totals = normalizeTotals(changes.cgTotals.newValue);
});

browser.webRequest.onBeforeRequest.addListener(
  interceptConversation,
  { urls: ["https://chatgpt.com/backend-api/conversation/*"] },
  ["blocking"]
);

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message) return undefined;
  if (message.type === "cg-get-stats") {
    const tabId = sender.tab ? sender.tab.id : message.tabId;
    return Promise.resolve(lastStatsByTab.get(tabId) || null);
  }
  if (message.type === "cg-get-window-history") {
    const tabId = sender.tab ? sender.tab.id : message.tabId;
    const history = historyByTab.get(tabId);
    return Promise.resolve(history || { ok: false, reason: "archive-not-found" });
  }
  if (message.type === "cg-get-totals") return Promise.resolve({ ...totals });
  if (message.type === "cg-reset-totals") {
    totals = { ...EMPTY_TOTALS };
    return browser.storage.local.set({ cgTotals: totals }).then(() => ({ ...totals }));
  }
  if (message.type === "cg-settings") {
    const next = {};
    if (typeof message.enabled === "boolean") next.enabled = message.enabled;
    if (LIMITED_MODES.has(message.mode)) next.mode = message.mode;
    if (Number.isFinite(Number(message.maxDisplayMessages))) next.maxDisplayMessages = normalizeMessageLimit(message.maxDisplayMessages);
    if (typeof message.showGuardNotice === "boolean") next.showGuardNotice = message.showGuardNotice;
    if (typeof message.archiveEnabled === "boolean") next.archiveEnabled = message.archiveEnabled;
    return browser.storage.local.set(next).then(() => {
      settings = { ...settings, ...next, mode: resolveMode(next.mode || settings.mode) };
      return settings;
    });
  }
  return undefined;
});

browser.tabs.onRemoved.addListener((tabId) => {
  lastStatsByTab.delete(tabId);
  historyByTab.delete(tabId);
});
