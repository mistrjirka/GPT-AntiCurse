/*
 * Chromium service worker.
 *
 * Conversation text never enters the service worker during normal browsing.
 * This worker only maintains aggregate, content-free performance counters.
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
const DIAGNOSTICS = globalThis.CGAntiCurseDiagnostics;
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

function recordIssue(scope, code, error, extra) {
  if (DIAGNOSTICS && typeof DIAGNOSTICS.record === "function") return DIAGNOSTICS.record(scope, code, error, extra);
  console.warn(`[GPT AntiCurse] ${scope}/${code}`, error, extra || "");
  return Promise.resolve(null);
}

function serializeCounterOperation(operation) {
  const queued = updateQueue.then(operation);
  updateQueue = queued.catch((error) => {
    console.warn("[GPT AntiCurse] Counter queue recovered after a failed operation", error);
  });
  return queued;
}

function recordStats(stats) {
  return serializeCounterOperation(async () => {
    const saved = await chrome.storage.local.get({ cgTotals: EMPTY_TOTALS });
    const next = addStats(normalizeTotals(saved.cgTotals), stats);
    await chrome.storage.local.set({ cgTotals: next });
    return next;
  });
}

function resetTotals() {
  return serializeCounterOperation(async () => {
    const empty = { ...EMPTY_TOTALS };
    await chrome.storage.local.set({ cgTotals: empty });
    return empty;
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;

  if (message.type === "cg-record-stats") {
    recordStats(message.stats).then(sendResponse).catch((error) => {
      recordIssue("counters", "update-failed", error);
      sendResponse({ ...EMPTY_TOTALS });
    });
    return true;
  }

  if (message.type === "cg-reset-totals") {
    resetTotals().then(sendResponse).catch((error) => {
      recordIssue("counters", "reset-failed", error);
      sendResponse({ ...EMPTY_TOTALS });
    });
    return true;
  }



  return false;
});
