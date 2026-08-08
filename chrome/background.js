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

function normalizeTotals(value) {
  const out = { ...EMPTY_TOTALS };
  if (!value || typeof value !== "object") return out;
  for (const key of Object.keys(out)) {
    const n = Number(value[key]);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}

let updateQueue = Promise.resolve();

function recordStats(stats) {
  updateQueue = updateQueue.then(async () => {
    const saved = await chrome.storage.local.get({ cgTotals: EMPTY_TOTALS });
    const totals = normalizeTotals(saved.cgTotals);
    if (!stats || stats.mode !== "trimmed") return totals;

    const before = Math.max(0, Number(stats.mappingNodesBefore) || 0);
    const after = Math.max(0, Number(stats.mappingNodesAfter) || 0);
    const removed = Math.max(0, Number(stats.discardedNodes) || (before - after));
    const inputBytes = Math.max(0, Number(stats.originalBytes) || 0);
    const outputBytes = Math.max(0, Number(stats.outputBytes) || 0);
    const bytesRemoved = inputBytes && outputBytes ? Math.max(0, inputBytes - outputBytes) : 0;

    const next = {
      responsesTrimmed: totals.responsesTrimmed + 1,
      nodesRemoved: totals.nodesRemoved + removed,
      nodesDelivered: totals.nodesDelivered + after,
      visibleTurnsKept: totals.visibleTurnsKept + Math.max(0, Number(stats.displayAfter) || 0),
      inputBytes: totals.inputBytes + inputBytes,
      outputBytes: totals.outputBytes + outputBytes,
      bytesRemoved: totals.bytesRemoved + bytesRemoved
    };
    await chrome.storage.local.set({ cgTotals: next });
    return next;
  });
  return updateQueue;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "cg-record-stats") {
    recordStats(message.stats).then(sendResponse).catch(() => sendResponse({ ...EMPTY_TOTALS }));
    return true;
  }
  if (message && message.type === "cg-reset-totals") {
    const empty = { ...EMPTY_TOTALS };
    chrome.storage.local.set({ cgTotals: empty }).then(() => sendResponse(empty));
    return true;
  }
  return false;
});
