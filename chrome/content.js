"use strict";

const CHANNEL = "__gpt_anticurse_v1__";
const STATS_EVENT = "__gpt_anticurse_stats_ready__";
const STALL_STATUS_EVENT = "__gpt_anticurse_stall_status__";
const STATUS_BADGE_ID = "cg-conversation-guard-status";
const STATUS_BADGE_SELECTOR = `[id="${STATUS_BADGE_ID}"]`;
const DEFAULT_SETTINGS = { enabled: true, mode: "windowed-visible", maxDisplayMessages: 64, showGuardNotice: true };
const RECOVERABLE_MAIN_CODES = new Set([
  "unsupported-conversation-shape",
  "conversation-transform-failed",
  "conversation-json-parse-failed"
]);
const DOM_GATE = globalThis.CGAntiCurseDomReady;
const DIAGNOSTICS = globalThis.CGAntiCurseDiagnostics;
const conversationScope = globalThis.CGConversationScope.create();
let currentSettings = { ...DEFAULT_SETTINGS };
let settingsReady = false;
let lastStats = null;
let lastIssue = null;
let stallStatus = null;
let badge;
let badgeObserver;
let hideTimer;
let renderQueuedForDomReady = false;

function belongsToCurrentConversation(conversationId) {
  const currentId = conversationScope.currentId();
  return !conversationId || !currentId || conversationId === currentId;
}

function statsBelongToCurrentConversation(stats) {
  return !stats || belongsToCurrentConversation(stats.conversationId);
}

function issueBelongsToCurrentConversation(issue) {
  return !issue || !issue.extra || belongsToCurrentConversation(issue.extra.conversationId);
}

function statusBadges() {
  return Array.from(document.querySelectorAll(STATUS_BADGE_SELECTOR));
}

function reconcileBadges() {
  const elements = statusBadges();
  if (!currentSettings.showGuardNotice) {
    for (const element of elements) element.remove();
    badge = null;
    return null;
  }
  if (!badge || !document.documentElement.contains(badge)) badge = elements[0] || null;
  for (const element of elements) {
    if (element !== badge) element.remove();
  }
  return badge;
}

function installBadgeObserver() {
  if (badgeObserver || !document.body) return;
  badgeObserver = new MutationObserver((records) => {
    const badgeAdded = records.some((record) => Array.from(record.addedNodes || []).some(
      (node) => node.nodeType === Node.ELEMENT_NODE && node.id === STATUS_BADGE_ID
    ));
    if (badgeAdded) reconcileBadges();
  });
  // AntiCurse status badges are direct body children. Keep this observer narrow
  // so ordinary ChatGPT subtree mutations never reach it.
  badgeObserver.observe(document.body, { childList: true });
}

function stopBadgeObserver() {
  if (badgeObserver) badgeObserver.disconnect();
  badgeObserver = null;
}

function removeBadge(stopObserver = false) {
  clearTimeout(hideTimer);
  for (const element of statusBadges()) element.remove();
  badge = null;
  if (stopObserver) stopBadgeObserver();
}

function ensureBadge() {
  installBadgeObserver();
  if (badge && document.documentElement.contains(badge)) return badge;
  reconcileBadges();
  if (badge) return badge;
  badge = document.createElement("div");
  badge.id = STATUS_BADGE_ID;
  badge.title = "GPT AntiCurse";
  (document.body || document.documentElement).appendChild(badge);
  reconcileBadges();
  return badge;
}

function span(className, text) {
  const element = document.createElement("span");
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function renderTrimmedBadge(element, metric, recent, compact = false) {
  const children = [span("cg-dot"), document.createElement("strong"), span("cg-accent", metric)];
  children[1].textContent = "AntiCurse";
  if (!compact) children.push(span("cg-sep", "•"), span("", `${recent.toLocaleString()} recent`));
  element.replaceChildren(...children);
}

function renderSimpleBadge(element, text) {
  const strong = document.createElement("strong");
  strong.textContent = "AntiCurse";
  element.replaceChildren(span("cg-dot"), strong, span("", text));
}

function pctRemoved(stats) {
  const before = Number(stats.mappingNodesBefore) || 0;
  const after = Number(stats.mappingNodesAfter) || 0;
  return before > 0 ? Math.round(Math.max(0, Math.min(100, ((before - after) / before) * 100))) : 0;
}

function payloadReduction(stats) {
  const input = Number(stats && stats.originalBytes);
  const output = Number(stats && stats.outputBytes);
  return Number.isFinite(input) && Number.isFinite(output) ? Math.max(0, input - output) : null;
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

function issueIsRecent(issue) {
  const at = issue && Date.parse(issue.at);
  return Number.isFinite(at) && Date.now() - at < 10 * 60 * 1000;
}

function activeStallStatus() {
  if (!stallStatus || stallStatus.active !== true) return null;
  return belongsToCurrentConversation(stallStatus.conversationId) ? stallStatus : null;
}

function formatRecoveryCountdown(value) {
  const seconds = Math.max(0, Math.ceil((Number(value) || 0) / 1000));
  if (seconds >= 60) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return `${seconds}s`;
}

function recoveryStatusText(status) {
  if (!status) return "";
  if (status.phase === "paused-hidden") return "auto-continue paused · tab hidden";
  if (status.phase === "paused-draft") return "auto-continue paused · draft present";
  if (status.phase === "checking") return "auto-continue checking…";
  if (status.phase === "grace") return "auto-continue confirming…";
  if (status.phase === "recovering") return "auto-continue resuming…";
  if (status.longWaitBanner) return "auto-continue now";
  return `${status.tool ? "tool " : ""}auto-continue in ${formatRecoveryCountdown(status.remainingMs)}`;
}

function appendRecoveryStatus(element) {
  const status = activeStallStatus();
  if (!element || !status) return false;
  element.append(span("cg-sep", "•"), span("cg-recovery", recoveryStatusText(status)));
  return true;
}

function queueRenderAfterDomReady() {
  if (!DOM_GATE || renderQueuedForDomReady) return;
  renderQueuedForDomReady = true;
  DOM_GATE.whenReady(() => {
    renderQueuedForDomReady = false;
    render(lastStats);
  });
}

function renderIssueIfNeeded() {
  if (!currentSettings.showGuardNotice || !lastIssue || !issueIsRecent(lastIssue) || !issueBelongsToCurrentConversation(lastIssue)) return false;
  if (!["history", "archive", "chromium-main", "settings"].includes(lastIssue.scope)) return false;
  const el = ensureBadge();
  el.dataset.mode = "error";
  el.classList.remove("cg-compact");
  el.textContent = "AntiCurse issue — open extension details";
  el.title = `${lastIssue.scope}/${lastIssue.code}\n${lastIssue.message}`;
  appendRecoveryStatus(el);
  return true;
}

function render(stats) {
  lastStats = stats || lastStats;
  if (lastStats && !statsBelongToCurrentConversation(lastStats)) {
    lastStats = null;
    removeBadge();
    return;
  }
  if (DOM_GATE && !DOM_GATE.isReady()) {
    queueRenderAfterDomReady();
    return;
  }
  installBadgeObserver();
  if (!currentSettings.showGuardNotice) {
    removeBadge(true);
    return;
  }
  if (renderIssueIfNeeded()) return;
  if (!lastStats) {
    const status = activeStallStatus();
    if (!status) { removeBadge(); return; }
    const el = ensureBadge();
    el.dataset.mode = "waiting";
    el.classList.remove("cg-compact");
    renderSimpleBadge(el, "watching response");
    appendRecoveryStatus(el);
    el.title = "Automatic stalled-run recovery countdown";
    return;
  }
  const el = ensureBadge();
  el.dataset.mode = lastStats.mode || "unknown";
  el.classList.remove("cg-compact");

  if (lastStats.mode === "trimmed") {
    const savedPercent = pctRemoved(lastStats);
    const savedBytes = payloadReduction(lastStats);
    const removed = Math.max(0, Number(lastStats.discardedNodes) || ((Number(lastStats.mappingNodesBefore) || 0) - (Number(lastStats.mappingNodesAfter) || 0)));
    const visible = Math.max(0, Number(lastStats.displayAfter) || 0);
    const logical = Number(lastStats.logicalDisplayAfter);
    const recent = Number.isFinite(logical) ? logical : visible;
    const simplifiedTools = Math.max(0, Number(lastStats.technicalUiToolCallsHidden) || 0);
    const uiOnly = simplifiedTools > 0 && removed === 0 && (!savedBytes || savedBytes <= 0);
    const metric = uiOnly
      ? `${simplifiedTools.toLocaleString()} tool cards simplified`
      : savedBytes != null && savedBytes > 0
        ? `${formatBytes(savedBytes)} trimmed`
        : removed > 0 ? `${savedPercent}% trimmed` : `${simplifiedTools.toLocaleString()} tool cards simplified`;
    renderTrimmedBadge(el, metric, recent);
    el.title = `${savedBytes != null && savedBytes > 0 ? `${formatBytes(savedBytes)} of response payload removed before ChatGPT page code processed it\n` : ""}${removed > 0 ? `Removed ${removed.toLocaleString()} internal mapping nodes (${savedPercent}%)\n` : ""}${simplifiedTools > 0 ? `Suppressed rich UI for ${simplifiedTools.toLocaleString()} completed tool calls while retaining their graph records\n` : ""}Kept ${recent.toLocaleString()} recent conversation units\nFilter processing: ${lastStats.processingMs} ms`;

    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (el && el.dataset.mode === "trimmed" && currentSettings.showGuardNotice && !renderIssueIfNeeded()) {
        renderTrimmedBadge(el, metric, recent, true);
        appendRecoveryStatus(el);
        el.classList.add("cg-compact");
      }
    }, 9000);
  } else if (lastStats.mode === "error") {
    el.textContent = "AntiCurse error — original response kept";
    el.title = lastStats.error || "Unknown interception error";
  } else if (lastStats.reason === "below-limit") {
    renderSimpleBadge(el, "no trimming needed");
  } else {
    renderSimpleBadge(el, `not optimized${lastStats.reason ? ` · ${lastStats.reason}` : ""}`);
  }
  appendRecoveryStatus(el);
}


function syncPerformanceClass() {
  if (currentSettings.enabled === true) document.documentElement.classList.add("cg-anticurse-performance");
  else document.documentElement.classList.remove("cg-anticurse-performance");
}

function postSettings() {
  if (!settingsReady) return false;
  window.postMessage({ channel: CHANNEL, type: "settings", settings: currentSettings }, location.origin);
  return true;
}

function recordDiagnostic(scope, code, error, extra) {
  if (DIAGNOSTICS && typeof DIAGNOSTICS.record === "function") return DIAGNOSTICS.record(scope, code, error, extra);
  console.warn(`[GPT AntiCurse] ${scope}/${code}`, error, extra || "");
  return Promise.resolve(null);
}

function recordTrimmedTotals(stats) {
  if (!stats || stats.mode !== "trimmed") return;
  chrome.runtime.sendMessage({ type: "cg-record-stats", stats }).then((totals) => {
    if (lastStats === stats && statsBelongToCurrentConversation(stats)) {
      lastStats = { ...stats, totals };
    }
  }).catch((error) => {
    console.warn("[GPT AntiCurse] Failed to update local counters", error);
  });
}

function clearRecoveredMainIssue(stats) {
  const validGraph = stats && (
    stats.mode === "trimmed" ||
    (stats.mode === "passthrough" && stats.reason === "below-limit")
  );
  if (!validGraph || !lastIssue || lastIssue.scope !== "chromium-main" || !RECOVERABLE_MAIN_CODES.has(lastIssue.code)) return;
  if (DIAGNOSTICS && typeof DIAGNOSTICS.clear === "function") DIAGNOSTICS.clear("chromium-main", lastIssue.code);
}

chrome.storage.local.get({ ...DEFAULT_SETTINGS, cgLastIssue: null }).then((saved) => {
  currentSettings = { ...DEFAULT_SETTINGS, ...saved };
  syncPerformanceClass();
  lastIssue = saved.cgLastIssue || null;
  settingsReady = true;
  postSettings();
  if (!currentSettings.showGuardNotice) removeBadge(true);
}).catch((error) => {
  settingsReady = true;
  postSettings();
  recordDiagnostic("settings", "storage-read-failed", error);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let settingsChanged = false;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!changes[key]) continue;
    currentSettings[key] = changes[key].newValue;
    settingsChanged = true;
  }
  const issueChanged = !!changes.cgLastIssue;
  if (issueChanged) lastIssue = changes.cgLastIssue.newValue || null;
  if (!settingsReady || (!settingsChanged && !issueChanged)) return;
  if (settingsChanged) { syncPerformanceClass(); postSettings(); }
  if (currentSettings.showGuardNotice) render(lastStats);
  else removeBadge(true);
});

window.addEventListener(STALL_STATUS_EVENT, (event) => {
  const detail = event && event.detail;
  if (detail && detail.active === true && !belongsToCurrentConversation(detail.conversationId)) return;
  stallStatus = detail && detail.active === true ? { ...detail } : null;
  render(lastStats);
});

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const msg = event.data;
  if (!msg || msg.channel !== CHANNEL) return;

  if (msg.type === "settings-request") {
    postSettings();
    return;
  }

  if (msg.type === "diagnostic" && msg.diagnostic) {
    const diagnostic = msg.diagnostic;
    if (!issueBelongsToCurrentConversation(diagnostic)) return;
    recordDiagnostic(diagnostic.scope || "chromium-main", diagnostic.code || "unknown", diagnostic.message, diagnostic.extra);
    return;
  }

  if (msg.type !== "stats") return;
  const stats = msg.stats || null;
  // A native older cursor request may already have been queued before the newest
  // page's cursor was suppressed. Its empty firewalled reply must not replace
  // the real current-page status/history hint when it completes later.
  if (stats && stats.paginationOlderPageBlocked) return;
  recordTrimmedTotals(stats);
  if (!statsBelongToCurrentConversation(stats)) return;

  lastStats = stats;
  clearRecoveredMainIssue(lastStats);
  render(lastStats);
  window.dispatchEvent(new CustomEvent(STATS_EVENT, { detail: {
    mode: lastStats && lastStats.mode,
    reason: lastStats && lastStats.reason,
    conversationId: lastStats && lastStats.conversationId,
    displayAfter: lastStats && Number.isFinite(Number(lastStats.displayAfter)) ? Number(lastStats.displayAfter) : null,
    paginationFirewall: !!(lastStats && lastStats.paginationFirewall),
    paginationCursorSuppressed: !!(lastStats && lastStats.paginationCursorSuppressed)
  } }));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "cg-get-stats") {
    sendResponse(statsBelongToCurrentConversation(lastStats) ? lastStats : null);
    return false;
  }
  return false;
});
