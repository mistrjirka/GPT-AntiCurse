/* Popup controller. Two history modes only: Recent N and Auto window. */
"use strict";

const EMPTY_TOTALS = { responsesTrimmed: 0, nodesRemoved: 0, nodesDelivered: 0, visibleTurnsKept: 0, inputBytes: 0, outputBytes: 0, bytesRemoved: 0 };
const CHATGPT_ORIGIN = "https://chatgpt.com/*";
const diagnostics = globalThis.CGAntiCurseDiagnostics;
const numberFormat = new Intl.NumberFormat();
const enabledInput = document.getElementById("enabled");
const modeSelect = document.getElementById("mode");
const modeHelp = document.getElementById("modeHelp");
const limitInput = document.getElementById("limit");
const noticeInput = document.getElementById("showNotice");
const feedback = document.getElementById("feedback");
const lastIssueElement = document.getElementById("lastIssue");
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
function isChatGPTTab(tab) { return !!(tab && typeof tab.url === "string" && /^https:\/\/chatgpt\.com\//.test(tab.url)); }
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
  const text = error && error.message ? error.message : String(error || "Unknown error");
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
async function currentTab() { return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]; }
async function hasHostAccess() {
  try {
    return await chrome.permissions.contains({ origins: [CHATGPT_ORIGIN] });
  } catch (error) {
    await recordSettingIssue("host-access-check-failed", error);
    throw error;
  }
}
async function requestHostAccess() {
  try {
    return await chrome.permissions.request({ origins: [CHATGPT_ORIGIN] });
  } catch (error) {
    await recordSettingIssue("host-access-request-failed", error);
    throw error;
  }
}
async function saveSettings() {
  try {
    await chrome.storage.local.set({ enabled: enabledInput.checked, mode: normalizeMode(modeSelect.value), maxDisplayMessages: messageLimit(), showGuardNotice: noticeInput.checked });
  } catch (error) {
    await recordSettingIssue("popup-save-failed", error);
    throw error;
  }
}
async function saveAndReload() {
  const tab = activeTab || await currentTab();
  if (isChatGPTTab(tab)) {
    const access = await hasHostAccess();
    if (!access) {
      const granted = await requestHostAccess();
      if (!granted) {
        setStatus("Needs access", "error");
        feedback.textContent = "Chrome site access was not granted. Allow GPT AntiCurse on chatgpt.com, then press Save & reload again.";
        return;
      }
      await clearBridgeIssue();
    }
  }
  await saveSettings();
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
  const logical = Number(stats.logicalDisplayAfter);
  document.getElementById("summarySub").textContent = Number.isFinite(logical)
    ? `${formatNumber(logical)} recent conversation units · ${formatNumber(stats.displayAfter)} visible records`
    : `${formatNumber(stats.displayAfter)} visible turns kept in ChatGPT`;
  document.getElementById("removedNodes").textContent = formatNumber(removed);
  document.getElementById("processing").textContent = Number.isFinite(Number(stats.processingMs)) ? `${stats.processingMs} ms` : "—";
  document.getElementById("bytesSaved").textContent = Number.isFinite(Number(stats.originalBytes)) && Number.isFinite(Number(stats.outputBytes))
    ? formatBytes(Math.max(0, stats.originalBytes - stats.outputBytes)) : "not measured";
  setStatus("Active", "active");
}
function renderStats(stats) {
  if (!stats) return setStatus("Waiting");
  if (stats.mode === "trimmed") return renderTrimmedStats(stats);
  if (stats.mode === "error") {
    setStatus("Error", "error");
    document.getElementById("summaryText").textContent = "Original response kept";
    document.getElementById("summarySub").textContent = stats.error || stats.reason || "AntiCurse reported an interception error.";
    return;
  }
  setStatus("Ready", "active");
  document.getElementById("savedPct").textContent = "0%";
  document.getElementById("summaryText").textContent = "No trimming needed";
}
async function initialize() {
  const saved = await chrome.storage.local.get({ enabled: true, mode: "recent", maxDisplayMessages: 64, showGuardNotice: true, cgTotals: EMPTY_TOTALS, cgLastIssue: null });
  enabledInput.checked = saved.enabled;
  modeSelect.value = normalizeMode(saved.mode);
  limitInput.value = saved.maxDisplayMessages;
  noticeInput.checked = saved.showGuardNotice !== false;
  renderTotals(saved.cgTotals);
  renderIssue(saved.cgLastIssue);
  updateControls();
  if (saved.mode !== modeSelect.value) await chrome.storage.local.set({ mode: modeSelect.value });

  activeTab = await currentTab();
  if (!activeTab || activeTab.id == null) return;
  if (!isChatGPTTab(activeTab)) {
    setStatus("Waiting");
    feedback.textContent = "Open a chatgpt.com conversation to use AntiCurse.";
    return;
  }

  if (!(await hasHostAccess())) {
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
    feedback.textContent = `AntiCurse is allowed on ChatGPT, but this tab has no content-script bridge: ${error && error.message ? error.message : error}. Press Save & reload.`;
  }
}

function runAction(label, action) {
  Promise.resolve().then(action).catch((error) => showError(label, error));
}

document.getElementById("reload").addEventListener("click", () => { saveAndReload().catch((error) => showError("Save/reload failed", error)); });
document.getElementById("resetTotals").addEventListener("click", () => runAction("Counter reset failed", async () => renderTotals(await chrome.runtime.sendMessage({ type: "cg-reset-totals" }))));
enabledInput.addEventListener("change", () => runAction("Saving settings failed", saveSettings));
noticeInput.addEventListener("change", () => runAction("Saving settings failed", saveSettings));
modeSelect.addEventListener("change", () => { updateControls(); runAction("Saving settings failed", saveSettings); });
limitInput.addEventListener("change", () => runAction("Saving settings failed", saveSettings));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.cgLastIssue) renderIssue(changes.cgLastIssue.newValue || null);
});
initialize().catch((error) => showError("Popup initialization failed", error));
