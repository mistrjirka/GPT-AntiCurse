/* Popup controller. Two history modes only: Recent N and Auto window. */
"use strict";

const popupContext = globalThis.CGPopupContext;
const EMPTY_TOTALS = { responsesTrimmed: 0, nodesRemoved: 0, nodesDelivered: 0, visibleTurnsKept: 0, inputBytes: 0, outputBytes: 0, bytesRemoved: 0 };
const diagnostics = popupContext.diagnostics;
const numberFormat = new Intl.NumberFormat();
const enabledInput = document.getElementById("enabled");
const modeSelect = document.getElementById("mode");
const modeHelp = document.getElementById("modeHelp");
const limitInput = document.getElementById("limit");
const noticeInput = document.getElementById("showNotice");
const stallRecoveryInput = document.getElementById("stallRecovery");
const feedback = document.getElementById("feedback");
const lastIssueElement = document.getElementById("lastIssue");
const primaryMetric = document.getElementById("primaryMetric");
let activeTab = null;

function normalizeMode(value) { return value === "windowed-visible" ? "windowed-visible" : "recent"; }
function formatNumber(value) { const number = Number(value); return numberFormat.format(Number.isFinite(number) ? number : 0); }
function formatBytes(value) {
  let number = Math.max(0, Number(value) || 0);
  const units = ["B", "KB", "MB", "GB"];
  let unitIndex = 0;
  while (number >= 1024 && unitIndex < units.length - 1) { number /= 1024; unitIndex++; }
  const digits = number >= 10 || unitIndex === 0 ? 0 : 1;
  return `${number.toFixed(digits)} ${units[unitIndex]}`;
}
function messageLimit() { return Math.max(4, Math.min(500, Number(limitInput.value) || 64)); }
function setDetailVisibility(labelId, valueId, visible) {
  document.getElementById(labelId).hidden = !visible;
  document.getElementById(valueId).hidden = !visible;
}
function updateControls() {
  modeHelp.textContent = modeSelect.value === "windowed-visible"
    ? "Automatically loads an older page when you reach the top."
    : "Keeps the latest window and shows Load previous N at the top.";
}
function setStatus(text, kind = "") {
  const status = document.getElementById("statusPill");
  status.textContent = text;
  status.className = `status${kind ? ` ${kind}` : ""}`;
}
function renderIssue(issue) {
  if (!issue) {
    lastIssueElement.textContent = "None";
    lastIssueElement.removeAttribute("title");
    return;
  }
  const code = `${issue.scope || "unknown"}/${issue.code || "unknown"}`;
  const message = issue.message || "Unknown error";
  lastIssueElement.textContent = `${code} — ${message}`;
  lastIssueElement.title = `${message}${issue.at ? `\n${new Date(issue.at).toLocaleString()}` : ""}`;
}
function showError(label, error) {
  const text = popupContext.errorText(error);
  console.error(`[GPT AntiCurse] ${label}`, error);
  feedback.textContent = `${label}: ${text}`;
  setStatus("Error", "error");
}
async function recordSettingIssue(code, error) {
  if (diagnostics && typeof diagnostics.record === "function") await diagnostics.record("settings", code, error);
}
async function clearBridgeIssue() {
  if (!diagnostics || typeof diagnostics.clear !== "function") return;
  await diagnostics.clear("bridge");
  await diagnostics.clear("archive", "popup-page-bridge-failed");
}
async function hasHostAccess(tab) {
  try {
    return await popupContext.hasPackageHostAccess(tab);
  } catch (error) {
    await recordSettingIssue("host-access-check-failed", error);
    throw error;
  }
}
async function saveSettings() {
  try {
    await chrome.storage.local.set({ enabled: enabledInput.checked, mode: normalizeMode(modeSelect.value), maxDisplayMessages: messageLimit(), showGuardNotice: noticeInput.checked, stallRecoveryEnabled: stallRecoveryInput.checked });
  } catch (error) {
    await recordSettingIssue("popup-save-failed", error);
    throw error;
  }
}
async function finishSaveAndReload(granted) {
  const tab = activeTab || await popupContext.currentTab();
  if (popupContext.isChatGPTTab(tab) && !granted) {
    setStatus("Needs access", "error");
    feedback.textContent = "Chrome site access was not granted. Allow GPT AntiCurse on chatgpt.com, then press Save & reload again.";
    return;
  }
  if (granted) await clearBridgeIssue();
  await saveSettings();
  if (tab && tab.id != null) await chrome.tabs.reload(tab.id);
  window.close();
}
function saveAndReloadFromUserGesture() {
  if (popupContext.isChatGPTTab(activeTab)) {
    chrome.permissions.request({ origins: [popupContext.CHATGPT_ORIGIN] })
      .then((granted) => finishSaveAndReload(granted))
      .catch(async (error) => {
        await recordSettingIssue("host-access-request-failed", error);
        showError("Save/reload failed", error);
      });
    return;
  }
  finishSaveAndReload(true).catch((error) => showError("Save/reload failed", error));
}
function renderTotals(value) {
  const totals = { ...EMPTY_TOTALS, ...(value || {}) };
  document.getElementById("totalResponses").textContent = formatNumber(totals.responsesTrimmed);
  document.getElementById("totalRemoved").textContent = formatNumber(totals.nodesRemoved);
  const measuredBytes = Math.max(0, Number(totals.bytesRemoved) || 0);
  setDetailVisibility("totalBytesLabel", "totalBytes", measuredBytes > 0);
  if (measuredBytes > 0) document.getElementById("totalBytes").textContent = formatBytes(measuredBytes);
}
function renderTrimmedStats(stats) {
  const before = Math.max(0, Number(stats.mappingNodesBefore) || 0);
  const after = Math.max(0, Number(stats.mappingNodesAfter) || 0);
  const removed = Math.max(0, Number(stats.discardedNodes) || before - after);
  const percentage = before ? Math.max(0, Math.min(100, (removed / before) * 100)) : 0;
  const logical = Number(stats.logicalDisplayAfter);
  const recent = Number.isFinite(logical) ? logical : Math.max(0, Number(stats.displayAfter) || 0);
  const bytesMeasured = Number.isFinite(Number(stats.originalBytes)) && Number.isFinite(Number(stats.outputBytes));
  const removedBytes = bytesMeasured ? Math.max(0, Number(stats.originalBytes) - Number(stats.outputBytes)) : null;
  const simplifiedTools = Math.max(0, Number(stats.technicalUiToolCallsHidden) || 0);
  const uiOnly = simplifiedTools > 0 && removed === 0 && (!removedBytes || removedBytes <= 0);

  if (uiOnly) {
    primaryMetric.textContent = formatNumber(simplifiedTools);
    document.getElementById("summaryText").textContent = "completed rich tool cards simplified";
    document.getElementById("summarySub").textContent = `Technical records stay in the conversation graph, but ChatGPT does not build their expensive completed tool UI. Kept ${formatNumber(recent)} recent conversation units.`;
    setDetailVisibility("bytesSavedLabel", "bytesSaved", false);
  } else if (bytesMeasured && removedBytes > 0) {
    primaryMetric.textContent = formatBytes(removedBytes);
    document.getElementById("summaryText").textContent = "response data removed from page state";
    document.getElementById("summarySub").textContent = `${percentage >= 99.5 ? percentage.toFixed(1) : Math.round(percentage)}% fewer internal nodes · kept ${formatNumber(recent)} recent conversation units in ChatGPT.`;
    document.getElementById("bytesSaved").textContent = `${formatBytes(removedBytes)} (${formatBytes(stats.originalBytes)} → ${formatBytes(stats.outputBytes)})`;
  } else {
    primaryMetric.textContent = simplifiedTools > 0 ? formatNumber(simplifiedTools) : `${percentage >= 99.5 ? percentage.toFixed(1) : Math.round(percentage)}%`;
    document.getElementById("summaryText").textContent = simplifiedTools > 0 ? "completed rich tool cards simplified" : "fewer internal nodes in this load";
    document.getElementById("summarySub").textContent = simplifiedTools > 0
      ? `Also removed ${formatNumber(removed)} internal nodes. Kept ${formatNumber(recent)} recent conversation units.`
      : `Kept ${formatNumber(recent)} recent conversation units in ChatGPT. Older history stays available through AntiCurse.`;
  }

  document.getElementById("removedNodes").textContent = formatNumber(removed);
  document.getElementById("processing").textContent = Number.isFinite(Number(stats.processingMs)) ? `${stats.processingMs} ms` : "—";
  setDetailVisibility("bytesSavedLabel", "bytesSaved", bytesMeasured);
  setStatus("Active", "active");
}
function renderStats(stats) {
  if (!stats) {
    setStatus("Waiting");
    primaryMetric.textContent = "—";
    document.getElementById("summaryText").textContent = "Waiting for a ChatGPT conversation";
    document.getElementById("summarySub").textContent = "Reload a conversation to measure its current load.";
    setDetailVisibility("bytesSavedLabel", "bytesSaved", false);
    return;
  }
  if (stats.mode === "trimmed") return renderTrimmedStats(stats);
  if (stats.mode === "error") {
    setStatus("Error", "error");
    primaryMetric.textContent = "—";
    document.getElementById("summaryText").textContent = "Original response kept";
    document.getElementById("summarySub").textContent = stats.error || stats.reason || "AntiCurse reported an interception error.";
    setDetailVisibility("bytesSavedLabel", "bytesSaved", false);
    return;
  }
  if (stats.reason === "disabled") {
    setStatus("Off");
    primaryMetric.textContent = "—";
    document.getElementById("summaryText").textContent = "Performance guard is off";
    document.getElementById("summarySub").textContent = "Enable it above and reload the conversation to optimize long chats.";
    setDetailVisibility("bytesSavedLabel", "bytesSaved", false);
    return;
  }
  if (stats.reason === "below-limit") {
    setStatus("Ready", "active");
    primaryMetric.textContent = "0%";
    document.getElementById("summaryText").textContent = "no trimming needed";
    document.getElementById("summarySub").textContent = "This conversation is already within the configured window and does not have excessive technical state.";
    setDetailVisibility("bytesSavedLabel", "bytesSaved", false);
    return;
  }
  setStatus("Bypassed", "error");
  primaryMetric.textContent = "—";
  document.getElementById("summaryText").textContent = "this load was not optimized";
  document.getElementById("summarySub").textContent = stats.reason
    ? `Reason: ${stats.reason}. Open Technical details or export a debug report for the exact cause.`
    : "AntiCurse passed this response through unchanged.";
  setDetailVisibility("bytesSavedLabel", "bytesSaved", false);
}
async function initialize() {
  const saved = await chrome.storage.local.get({ enabled: true, mode: "windowed-visible", maxDisplayMessages: 64, showGuardNotice: true, stallRecoveryEnabled: true, cgTotals: EMPTY_TOTALS, cgLastIssue: null });
  enabledInput.checked = saved.enabled;
  modeSelect.value = normalizeMode(saved.mode);
  limitInput.value = saved.maxDisplayMessages;
  noticeInput.checked = saved.showGuardNotice !== false;
  stallRecoveryInput.checked = saved.stallRecoveryEnabled !== false;
  renderTotals(saved.cgTotals);
  renderIssue(saved.cgLastIssue);
  updateControls();
  if (saved.mode !== modeSelect.value) await chrome.storage.local.set({ mode: modeSelect.value });

  activeTab = await popupContext.currentTab();
  if (!activeTab || activeTab.id == null) return;
  if (!popupContext.isChatGPTTab(activeTab)) {
    setStatus("Waiting");
    feedback.textContent = "Open a chatgpt.com conversation to use AntiCurse.";
    return;
  }

  if (!(await hasHostAccess(activeTab))) {
    await clearBridgeIssue();
    setStatus("Needs access", "error");
    feedback.textContent = "Chrome has withheld access to chatgpt.com. Press Save & reload to grant site access and reload this tab.";
    return;
  }

  try {
    renderStats(await chrome.tabs.sendMessage(activeTab.id, { type: "cg-get-stats" }));
    await clearBridgeIssue();
  } catch (error) {
    console.warn("[GPT AntiCurse] Could not reach the page-side status bridge", error);
    if (diagnostics && typeof diagnostics.record === "function") await diagnostics.record("bridge", "content-script-missing", error);
    setStatus("Reload required", "error");
    feedback.textContent = `AntiCurse is allowed on ChatGPT, but this tab has no content-script bridge: ${popupContext.errorText(error)}. Press Save & reload.`;
  }
}

function runAction(label, action) {
  Promise.resolve().then(action).catch((error) => showError(label, error));
}

document.getElementById("reload").addEventListener("click", saveAndReloadFromUserGesture);
document.getElementById("resetTotals").addEventListener("click", () => runAction("Counter reset failed", async () => renderTotals(await chrome.runtime.sendMessage({ type: "cg-reset-totals" }))));
enabledInput.addEventListener("change", () => runAction("Saving settings failed", saveSettings));
noticeInput.addEventListener("change", () => runAction("Saving settings failed", saveSettings));
stallRecoveryInput.addEventListener("change", () => runAction("Saving settings failed", saveSettings));
modeSelect.addEventListener("change", () => { updateControls(); runAction("Saving settings failed", saveSettings); });
limitInput.addEventListener("change", () => runAction("Saving settings failed", saveSettings));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.cgLastIssue) renderIssue(changes.cgLastIssue.newValue || null);
});
initialize().catch((error) => showError("Popup initialization failed", error));
