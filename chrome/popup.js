/* Popup controller. UI is intentionally small; detailed diagnostics stay collapsed. */
"use strict";

const EMPTY_TOTALS = {
  responsesTrimmed: 0,
  nodesRemoved: 0,
  nodesDelivered: 0,
  visibleTurnsKept: 0,
  inputBytes: 0,
  outputBytes: 0,
  bytesRemoved: 0
};

const numberFormat = new Intl.NumberFormat();
const enabledInput = document.getElementById("enabled");
const modeSelect = document.getElementById("mode");
const limitInput = document.getElementById("limit");
const noticeInput = document.getElementById("showNotice");
const loadPreviousButton = document.getElementById("loadPrevious");
const feedback = document.getElementById("feedback");

function formatNumber(value) {
  const number = Number(value);
  return numberFormat.format(Number.isFinite(number) ? number : 0);
}

function formatBytes(value) {
  let number = Math.max(0, Number(value) || 0);
  const units = ["B", "KB", "MB", "GB"];
  let unitIndex = 0;

  while (number >= 1024 && unitIndex < units.length - 1) {
    number /= 1024;
    unitIndex++;
  }

  const digits = number >= 10 || unitIndex === 0 ? 0 : 1;
  return `${number.toFixed(digits)} ${units[unitIndex]}`;
}

function messageLimit() {
  return Math.max(4, Math.min(500, Number(limitInput.value) || 32));
}

function isLimitedMode() {
  return modeSelect.value !== "visible-history";
}

function updateControls() {
  limitInput.disabled = !isLimitedMode();
  loadPreviousButton.disabled = !isLimitedMode();
  loadPreviousButton.textContent = `Load previous ${messageLimit()}`;
}

function setFeedback(message) {
  feedback.textContent = message || "";
}

function setStatus(text, kind = "") {
  const status = document.getElementById("statusPill");
  status.textContent = text;
  status.className = `status${kind ? ` ${kind}` : ""}`;
}

async function currentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function saveSettings() {
  return chrome.storage.local.set({
    enabled: enabledInput.checked,
    mode: modeSelect.value,
    maxDisplayMessages: messageLimit(),
    showGuardNotice: noticeInput.checked
  });
}

async function saveAndReload() {
  await saveSettings();
  const tab = await currentTab();
  if (tab && tab.id != null) await chrome.tabs.reload(tab.id);
  window.close();
}

function renderTotals(value) {
  const totals = { ...EMPTY_TOTALS, ...(value || {}) };
  document.getElementById("totalResponses").textContent = formatNumber(totals.responsesTrimmed);
  document.getElementById("totalRemoved").textContent = formatNumber(totals.nodesRemoved);
  document.getElementById("totalBytes").textContent = formatBytes(totals.bytesRemoved);
}

function renderTrimmedStats(stats) {
  const before = Math.max(0, Number(stats.mappingNodesBefore) || 0);
  const after = Math.max(0, Number(stats.mappingNodesAfter) || 0);
  const removed = Math.max(0, Number(stats.discardedNodes) || before - after);
  const percentage = before ? Math.max(0, Math.min(100, (removed / before) * 100)) : 0;

  document.getElementById("savedPct").textContent = `${percentage >= 99.5 ? percentage.toFixed(1) : Math.round(percentage)}%`;
  document.getElementById("summaryText").textContent = `${formatNumber(before)} → ${formatNumber(after)} nodes`;
  document.getElementById("summarySub").textContent = `${formatNumber(stats.displayAfter)} visible turns kept in ChatGPT`;
  document.getElementById("removedNodes").textContent = formatNumber(removed);
  document.getElementById("processing").textContent = Number.isFinite(Number(stats.processingMs)) ? `${stats.processingMs} ms` : "—";

  if (Number.isFinite(Number(stats.originalBytes)) && Number.isFinite(Number(stats.outputBytes))) {
    document.getElementById("bytesSaved").textContent = formatBytes(Math.max(0, stats.originalBytes - stats.outputBytes));
  } else {
    document.getElementById("bytesSaved").textContent = "not measured";
  }

  setStatus("Active", "active");
}

function renderStats(stats) {
  if (!stats) {
    setStatus("Waiting");
    return;
  }

  if (stats.mode === "trimmed") {
    renderTrimmedStats(stats);
    return;
  }

  if (stats.mode === "error") {
    setStatus("Error", "error");
    document.getElementById("summaryText").textContent = "Original response kept";
    return;
  }

  setStatus("Ready", "active");
  document.getElementById("savedPct").textContent = "0%";
  document.getElementById("summaryText").textContent = "No trimming needed";
}

async function openPreviousHistory() {
  await saveSettings();
  const tab = await currentTab();
  if (!tab || tab.id == null) return;

  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: "cg-open-window-history" });
    if (result && result.ok) {
      window.close();
      return;
    }

    if (result && result.reason === "no-history-archive") {
      setFeedback("Reload this chat once to create its history archive.");
    } else {
      setFeedback("No older visible turns are available.");
    }
  } catch (_) {
    setFeedback("Open a ChatGPT conversation first.");
  }
}

async function initialize() {
  const saved = await chrome.storage.local.get({
    enabled: true,
    mode: "visible-history",
    maxDisplayMessages: 32,
    showGuardNotice: true,
    cgTotals: EMPTY_TOTALS
  });

  enabledInput.checked = saved.enabled;
  modeSelect.value = saved.mode;
  limitInput.value = saved.maxDisplayMessages;
  noticeInput.checked = saved.showGuardNotice !== false;
  renderTotals(saved.cgTotals);
  updateControls();

  const tab = await currentTab();
  if (!tab || tab.id == null) return;
  try {
    renderStats(await chrome.tabs.sendMessage(tab.id, { type: "cg-get-stats" }));
  } catch (_) {}
}

document.getElementById("reload").addEventListener("click", saveAndReload);
document.getElementById("resetTotals").addEventListener("click", async () => {
  renderTotals(await chrome.runtime.sendMessage({ type: "cg-reset-totals" }));
});
loadPreviousButton.addEventListener("click", openPreviousHistory);

enabledInput.addEventListener("change", saveSettings);
noticeInput.addEventListener("change", saveSettings);
modeSelect.addEventListener("change", () => {
  updateControls();
  saveSettings();
});
limitInput.addEventListener("change", () => {
  updateControls();
  saveSettings();
});

initialize().catch(() => {});
