/*
 * Chromium service worker.
 *
 * The page/content scripts perform conversation transformation. This worker has
 * one narrow job: serialize updates to local numeric counters so multiple tabs
 * cannot overwrite each other's totals.
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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

  return false;
});
