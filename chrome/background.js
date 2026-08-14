/*
 * Chromium service worker.
 *
 * Durable conversation history lives in the extension-origin IndexedDB archive.
 * The MAIN-world interceptor never owns history state; it only transforms the
 * page response and publishes the authoritative untrimmed archive once through
 * the isolated bridge. This worker serves history back to the isolated UI using
 * normal Manifest V3 extension messaging.
 */
"use strict";

const EMPTY_TOTALS = Object.freeze({
  responsesTrimmed: 0,
  nodesRemoved: 0,
  nodesDelivered: 0,
  visibleTurnsKept: 0,
  inputBytes: 0,
  outputBytes: 0,
  bytesRemoved: 0
});

let updateQueue = Promise.resolve();

function normalizeTotals(value) {
  const result = { ...EMPTY_TOTALS };
  if (!value || typeof value !== "object") return result;

  for (const key of Object.keys(result)) {
    const number = Number(value[key]);
    if (Number.isFinite(number) && number >= 0) result[key] = number;
  }
  return result;
}

function normalizeMessageLimit(value) {
  const number = Number(value);
  return Math.max(4, Math.min(500, Number.isFinite(number) ? number : 64));
}

function addStats(totals, stats) {
  if (!stats || stats.mode !== "trimmed") return totals;

  const before = Math.max(0, Number(stats.mappingNodesBefore) || 0);
  const after = Math.max(0, Number(stats.mappingNodesAfter) || 0);
  const removed = Math.max(0, Number(stats.discardedNodes) || before - after);
  const inputBytes = Math.max(0, Number(stats.originalBytes) || 0);
  const outputBytes = Math.max(0, Number(stats.outputBytes) || 0);
  const bytesRemoved = inputBytes && outputBytes ? Math.max(0, inputBytes - outputBytes) : 0;

  return {
    responsesTrimmed: totals.responsesTrimmed + 1,
    nodesRemoved: totals.nodesRemoved + removed,
    nodesDelivered: totals.nodesDelivered + after,
    visibleTurnsKept: totals.visibleTurnsKept + Math.max(0, Number(stats.displayAfter) || 0),
    inputBytes: totals.inputBytes + inputBytes,
    outputBytes: totals.outputBytes + outputBytes,
    bytesRemoved: totals.bytesRemoved + bytesRemoved
  };
}

function recordStats(stats) {
  updateQueue = updateQueue.then(async () => {
    const saved = await chrome.storage.local.get({ cgTotals: EMPTY_TOTALS });
    const next = addStats(normalizeTotals(saved.cgTotals), stats);
    await chrome.storage.local.set({ cgTotals: next });
    return next;
  });
  return updateQueue;
}

function resetTotals() {
  const empty = { ...EMPTY_TOTALS };
  return chrome.storage.local.set({ cgTotals: empty }).then(() => empty);
}

function conversationIdFromMessage(message, sender) {
  if (message && typeof message.conversationId === "string" && message.conversationId) return message.conversationId;
  const urlString = sender && sender.tab && sender.tab.url;
  if (!urlString) return null;
  try {
    const match = new URL(urlString).pathname.match(/(?:^|\/)c\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch (_) {
    return null;
  }
}

function rawVisibleWindowCount(messages, requestedLimit) {
  const limit = normalizeMessageLimit(requestedLimit);
  if (!Array.isArray(messages) || !messages.length) return 0;

  const units = [];
  let unit = -1;
  let previousRole = null;
  for (const message of messages) {
    const role = message && message.role === "user" ? "user" : "assistant";
    if (role === "user" || previousRole !== "assistant") unit++;
    units.push(unit);
    previousRole = role;
  }

  const totalUnits = unit + 1;
  if (totalUnits <= limit) return messages.length;
  const cutoff = totalUnits - limit;
  const first = units.findIndex((value) => value >= cutoff);
  return first < 0 ? messages.length : messages.length - first;
}

async function getWindowHistory(message, sender) {
  const conversationId = conversationIdFromMessage(message, sender);
  if (!conversationId) return null;

  const archive = await CGArchiveStore.get(conversationId);
  if (!archive || !Array.isArray(archive.messages)) return null;

  const saved = await chrome.storage.local.get({ maxDisplayMessages: 64 });
  const limit = normalizeMessageLimit(
    Number.isFinite(Number(message && message.maxDisplayMessages))
      ? message.maxDisplayMessages
      : saved.maxDisplayMessages
  );
  const messages = archive.messages.map((entry) => ({
    id: entry.id,
    role: entry.role,
    text: entry.text,
    createTime: entry.createTime == null ? null : entry.createTime
  }));

  return {
    messages,
    nativeVisibleCount: rawVisibleWindowCount(messages, limit),
    pageSize: limit,
    maxRendered: Math.max(limit, Math.min(500, limit * 3)),
    source: "extension-indexeddb"
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === "cg-record-stats") {
    recordStats(message.stats)
      .then(sendResponse)
      .catch(() => sendResponse({ ...EMPTY_TOTALS }));
    return true;
  }

  if (message.type === "cg-reset-totals") {
    resetTotals().then(sendResponse);
    return true;
  }

  if (message.type === "cg-get-window-history") {
    getWindowHistory(message, sender)
      .then(sendResponse)
      .catch(() => sendResponse(null));
    return true;
  }

  return false;
});
