"use strict";

const DOM_GATE = globalThis.CGAntiCurseDomReady;
const DIAGNOSTICS = globalThis.CGAntiCurseDiagnostics;
const STATS_EVENT = "__gpt_anticurse_stats_ready__";
const STATUS_BADGE_SELECTOR = '[id="cg-conversation-guard-status"]';
const conversationScope = globalThis.CGConversationScope.create();
let badge;
let hideTimer;
let lastStats = null;
let lastIssue = null;
let showGuardNotice = true;
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

function recordIssue(scope, code, error, extra) {
  if (DIAGNOSTICS && typeof DIAGNOSTICS.record === "function") return DIAGNOSTICS.record(scope, code, error, extra);
  console.warn(`[GPT AntiCurse] ${scope}/${code}`, error, extra || "");
  return Promise.resolve(null);
}

function statusBadges() {
  return Array.from(document.querySelectorAll(STATUS_BADGE_SELECTOR));
}

function removeBadge() {
  clearTimeout(hideTimer);
  for (const element of statusBadges()) element.remove();
  badge = null;
}

function ensureBadge() {
  const existing = statusBadges();
  if (!badge || !document.documentElement.contains(badge)) badge = existing[0] || null;
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "cg-conversation-guard-status";
    (document.body || document.documentElement).appendChild(badge);
  }
  for (const element of existing) {
    if (element !== badge) element.remove();
  }
  badge.title = "GPT AntiCurse";
  return badge;
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
  if (!showGuardNotice) {
    removeBadge();
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
    const metric = savedBytes != null ? `${formatBytes(savedBytes)} trimmed` : `${savedPercent}% trimmed`;
    el.innerHTML = `<span class="cg-dot"></span><strong>AntiCurse</strong><span class="cg-accent">${metric}</span><span class="cg-sep">•</span><span>${recent.toLocaleString()} recent</span>`;
    el.title = `${savedBytes != null ? `${formatBytes(savedBytes)} of response payload removed before ChatGPT page code processed it\n` : ""}Removed ${removed.toLocaleString()} internal mapping nodes (${savedPercent}%)\nKept ${recent.toLocaleString()} recent conversation units\nFilter processing: ${lastStats.processingMs} ms`;

    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (el && el.dataset.mode === "trimmed" && showGuardNotice && !renderIssueIfNeeded()) {
        el.innerHTML = `<span class="cg-dot"></span><strong>AntiCurse</strong><span class="cg-accent">${metric}</span>`;
        el.classList.add("cg-compact");
      }
    }, 9000);
  } else if (lastStats.mode === "error") {
    el.textContent = "AntiCurse error — original response kept";
    el.title = lastStats.error || lastStats.reason || "Unknown interception error";
  } else {
    el.innerHTML = `<span class="cg-dot"></span><strong>AntiCurse</strong><span>no trimming needed</span>`;
  }
}

function acceptStats(stats) {
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
    conversationId: lastStats.conversationId
  } }));
  return true;
}

browser.storage.local.get({ showGuardNotice: true, cgLastIssue: null }).then((saved) => {
  showGuardNotice = saved.showGuardNotice !== false;
  lastIssue = saved.cgLastIssue || null;
  if (!showGuardNotice) removeBadge();
}).catch((error) => recordIssue("settings", "firefox-content-storage-read-failed", error));

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.showGuardNotice) showGuardNotice = changes.showGuardNotice.newValue !== false;
  if (changes.cgLastIssue) lastIssue = changes.cgLastIssue.newValue || null;
  if (showGuardNotice) render(lastStats);
  else removeBadge();
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
