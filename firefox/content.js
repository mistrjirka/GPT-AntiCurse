"use strict";

const DOM_GATE = globalThis.CGAntiCurseDomReady;
const DIAGNOSTICS = globalThis.CGAntiCurseDiagnostics;
const STATS_EVENT = "__gpt_anticurse_stats_ready__";
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

function removeBadge() {
  clearTimeout(hideTimer);
  if (badge) badge.remove();
  badge = null;
}

function ensureBadge() {
  if (badge && document.documentElement.contains(badge)) return badge;
  badge = document.createElement("div");
  badge.id = "cg-conversation-guard-status";
  badge.title = "GPT AntiCurse";
  (document.body || document.documentElement).appendChild(badge);
  return badge;
}

function pctRemoved(stats) {
  const before = Number(stats.mappingNodesBefore) || 0;
  const after = Number(stats.mappingNodesAfter) || 0;
  return before > 0 ? Math.round(Math.max(0, Math.min(100, ((before - after) / before) * 100))) : 0;
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
    const saved = pctRemoved(lastStats);
    const removed = Math.max(0, Number(lastStats.discardedNodes) || ((Number(lastStats.mappingNodesBefore) || 0) - (Number(lastStats.mappingNodesAfter) || 0)));
    const visible = Math.max(0, Number(lastStats.displayAfter) || 0);
    el.innerHTML = `<span class="cg-dot"></span><strong>AntiCurse</strong><span class="cg-accent">${saved}% trimmed</span><span class="cg-sep">•</span><span>${visible.toLocaleString()} visible</span>`;
    el.title = `Removed ${removed.toLocaleString()} internal mapping nodes\n${lastStats.mappingNodesBefore} → ${lastStats.mappingNodesAfter} nodes delivered to ChatGPT\n${visible} visible user/assistant turns preserved\nFilter processing: ${lastStats.processingMs} ms`;

    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (el && el.dataset.mode === "trimmed" && showGuardNotice && !renderIssueIfNeeded()) {
        el.innerHTML = `<span class="cg-dot"></span><strong>AntiCurse</strong><span class="cg-accent">${saved}% trimmed</span>`;
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
