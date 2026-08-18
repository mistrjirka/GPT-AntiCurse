"use strict";

const CHANNEL = "__gpt_anticurse_v1__";
const STATS_EVENT = "__gpt_anticurse_stats_ready__";
const DEFAULT_SETTINGS = { enabled: true, mode: "recent", maxDisplayMessages: 64, showGuardNotice: true };
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
let badge;
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
  if (!currentSettings.showGuardNotice) {
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
      if (el && el.dataset.mode === "trimmed" && currentSettings.showGuardNotice && !renderIssueIfNeeded()) {
        el.innerHTML = `<span class="cg-dot"></span><strong>AntiCurse</strong><span class="cg-accent">${saved}% trimmed</span>`;
        el.classList.add("cg-compact");
      }
    }, 9000);
  } else if (lastStats.mode === "error") {
    el.textContent = "AntiCurse error — original response kept";
    el.title = lastStats.error || "Unknown interception error";
  } else {
    el.innerHTML = `<span class="cg-dot"></span><strong>AntiCurse</strong><span>no trimming needed</span>`;
  }
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
  lastIssue = saved.cgLastIssue || null;
  settingsReady = true;
  postSettings();
  if (!currentSettings.showGuardNotice) removeBadge();
}).catch((error) => {
  settingsReady = true;
  postSettings();
  recordDiagnostic("settings", "storage-read-failed", error);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (changes[key]) currentSettings[key] = changes[key].newValue;
  }
  if (changes.cgLastIssue) lastIssue = changes.cgLastIssue.newValue || null;
  if (!settingsReady) return;
  postSettings();
  if (currentSettings.showGuardNotice) render(lastStats);
  else removeBadge();
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

  if (msg.type !== "stats" || !statsBelongToCurrentConversation(msg.stats)) return;
  lastStats = msg.stats || null;
  clearRecoveredMainIssue(lastStats);
  render(lastStats);
  window.dispatchEvent(new CustomEvent(STATS_EVENT, { detail: {
    mode: lastStats && lastStats.mode,
    reason: lastStats && lastStats.reason,
    conversationId: lastStats && lastStats.conversationId
  } }));

  if (lastStats && lastStats.mode === "trimmed") {
    chrome.runtime.sendMessage({ type: "cg-record-stats", stats: lastStats }).then((totals) => {
      if (lastStats && statsBelongToCurrentConversation(lastStats)) lastStats = { ...lastStats, totals };
    }).catch((error) => {
      console.warn("[GPT AntiCurse] Failed to update local counters", error);
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "cg-get-stats") {
    sendResponse(statsBelongToCurrentConversation(lastStats) ? lastStats : null);
    return false;
  }
  return false;
});
