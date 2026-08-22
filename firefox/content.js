"use strict";

const DOM_GATE = globalThis.CGAntiCurseDomReady;
const DIAGNOSTICS = globalThis.CGAntiCurseDiagnostics;
const STATS_EVENT = "__gpt_anticurse_stats_ready__";
const STATUS_BADGE_ID = "cg-conversation-guard-status";
const STATUS_BADGE_SELECTOR = `[id="${STATUS_BADGE_ID}"]`;
const conversationScope = globalThis.CGConversationScope.create();
let badge;
let badgeObserver;
let hideTimer;
let lastStats = null;
let lastIssue = null;
let showGuardNotice = true;
let performanceEnabled = true;
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

function syncPerformanceClass() {
  if (performanceEnabled === true) document.documentElement.classList.add("cg-anticurse-performance");
  else document.documentElement.classList.remove("cg-anticurse-performance");
}

function recordIssue(scope, code, error, extra) {
  if (DIAGNOSTICS && typeof DIAGNOSTICS.record === "function") return DIAGNOSTICS.record(scope, code, error, extra);
  console.warn(`[GPT AntiCurse] ${scope}/${code}`, error, extra || "");
  return Promise.resolve(null);
}

function statusBadges() {
  return Array.from(document.querySelectorAll(STATUS_BADGE_SELECTOR));
}

function reconcileBadges() {
  const elements = statusBadges();
  if (!showGuardNotice) {
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

function renderIssueIfNeeded() {
  if (!showGuardNotice || !lastIssue || !issueIsRecent(lastIssue) || !issueBelongsToCurrentConversation(lastIssue)) return false;
  if (!["history", "archive", "interceptor", "settings"].includes(lastIssue.scope)) return false;
  const el = ensureBadge();
  el.dataset.mode = "error";
  el.classList.remove("cg-compact");
  el.textContent = "AntiCurse issue — open extension details";
  el.title = `${lastIssue.scope}/${lastIssue.code}\n${lastIssue.message}`;
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
  if (!showGuardNotice) {
    removeBadge(true);
    return;
  }
  if (renderIssueIfNeeded()) return;
  if (!lastStats) return;

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
      if (el && el.dataset.mode === "trimmed" && showGuardNotice && !renderIssueIfNeeded()) {
        renderTrimmedBadge(el, metric, recent, true);
        el.classList.add("cg-compact");
      }
    }, 9000);
  } else if (lastStats.mode === "error") {
    el.textContent = "AntiCurse error — original response kept";
    el.title = lastStats.error || lastStats.reason || "Unknown interception error";
  } else if (lastStats.reason === "below-limit") {
    renderSimpleBadge(el, "no trimming needed");
  } else {
    renderSimpleBadge(el, `not optimized${lastStats.reason ? ` · ${lastStats.reason}` : ""}`);
  }
}

function acceptStats(stats) {
  if (stats && stats.paginationOlderPageBlocked) return false;
  if (!stats) {
    lastStats = null;
    render(null);
    return true;
  }
  if (!statsBelongToCurrentConversation(stats)) {
    if (lastStats && !statsBelongToCurrentConversation(lastStats)) {
      lastStats = null;
      removeBadge();
    }
    return false;
  }
  lastStats = stats;
  if (lastStats.mode === "trimmed" && DIAGNOSTICS && typeof DIAGNOSTICS.clear === "function") {
    DIAGNOSTICS.clear("interceptor");
  }
  render(lastStats);
  window.dispatchEvent(new CustomEvent(STATS_EVENT, { detail: {
    mode: lastStats.mode,
    reason: lastStats.reason,
    conversationId: lastStats.conversationId,
    displayAfter: Number.isFinite(Number(lastStats.displayAfter)) ? Number(lastStats.displayAfter) : null,
    paginationFirewall: !!lastStats.paginationFirewall,
    paginationCursorSuppressed: !!lastStats.paginationCursorSuppressed
  } }));
  return true;
}

browser.storage.local.get({ enabled: true, showGuardNotice: true, cgLastIssue: null }).then((saved) => {
  performanceEnabled = saved.enabled !== false;
  syncPerformanceClass();
  showGuardNotice = saved.showGuardNotice !== false;
  lastIssue = saved.cgLastIssue || null;
  if (!showGuardNotice) removeBadge(true);
}).catch((error) => recordIssue("settings", "firefox-content-storage-read-failed", error));

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const enabledChanged = !!changes.enabled;
  const noticeChanged = !!changes.showGuardNotice;
  const issueChanged = !!changes.cgLastIssue;
  if (!enabledChanged && !noticeChanged && !issueChanged) return;
  if (enabledChanged) { performanceEnabled = changes.enabled.newValue !== false; syncPerformanceClass(); }
  if (noticeChanged) showGuardNotice = changes.showGuardNotice.newValue !== false;
  if (issueChanged) lastIssue = changes.cgLastIssue.newValue || null;
  if (showGuardNotice) render(lastStats);
  else removeBadge(true);
});

browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === "cg-stats") acceptStats(message.stats);
});

browser.runtime.sendMessage({
  type: "cg-get-stats",
  conversationId: conversationScope.currentId()
}).then(acceptStats).catch((error) => {
  recordIssue("interceptor", "initial-stats-request-failed", error);
});
