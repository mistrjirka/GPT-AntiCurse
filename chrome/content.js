"use strict";

const CHANNEL = "__gpt_anticurse_v1__";
const DEFAULT_SETTINGS = { enabled: true, mode: "visible-history", maxDisplayMessages: 32, showGuardNotice: true };
let currentSettings = { ...DEFAULT_SETTINGS };
let lastStats = null;
let badge;
let hideTimer;

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

function render(stats) {
  lastStats = stats || lastStats;
  if (!currentSettings.showGuardNotice) {
    removeBadge();
    return;
  }
  if (!stats) return;
  const el = ensureBadge();
  el.dataset.mode = stats.mode || "unknown";
  el.classList.remove("cg-compact");

  if (stats.mode === "trimmed") {
    const saved = pctRemoved(stats);
    const removed = Math.max(0, Number(stats.discardedNodes) || ((Number(stats.mappingNodesBefore) || 0) - (Number(stats.mappingNodesAfter) || 0)));
    const visible = Math.max(0, Number(stats.displayAfter) || 0);
    el.innerHTML = `<span class="cg-dot"></span><strong>AntiCurse</strong><span class="cg-accent">${saved}% trimmed</span><span class="cg-sep">•</span><span>${visible.toLocaleString()} visible</span>`;
    el.title = `Removed ${removed.toLocaleString()} internal mapping nodes\n${stats.mappingNodesBefore} → ${stats.mappingNodesAfter} nodes delivered to ChatGPT\n${visible} visible user/assistant turns preserved\nFilter processing: ${stats.processingMs} ms`;

    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (el && el.dataset.mode === "trimmed" && currentSettings.showGuardNotice) {
        el.innerHTML = `<span class="cg-dot"></span><strong>AntiCurse</strong><span class="cg-accent">${saved}% trimmed</span>`;
        el.classList.add("cg-compact");
      }
    }, 9000);
  } else if (stats.mode === "error") {
    el.textContent = "AntiCurse error — original response kept";
    el.title = stats.error || "Unknown interception error";
  } else {
    el.innerHTML = `<span class="cg-dot"></span><strong>AntiCurse</strong><span>no trimming needed</span>`;
  }
}

function postSettings() {
  window.postMessage({ channel: CHANNEL, type: "settings", settings: currentSettings }, location.origin);
}

chrome.storage.local.get(DEFAULT_SETTINGS).then((saved) => {
  currentSettings = { ...DEFAULT_SETTINGS, ...saved };
  postSettings();
  if (!currentSettings.showGuardNotice) removeBadge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (changes[key]) currentSettings[key] = changes[key].newValue;
  }
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
  } else if (msg.type === "stats") {
    lastStats = msg.stats || null;
    render(lastStats);
    if (lastStats && lastStats.mode === "trimmed") {
      chrome.runtime.sendMessage({ type: "cg-record-stats", stats: lastStats }).then((totals) => {
        if (lastStats) lastStats = { ...lastStats, totals };
      }).catch(() => {});
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "cg-get-stats") {
    sendResponse(lastStats);
    return false;
  }
  return false;
});
