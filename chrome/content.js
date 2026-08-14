"use strict";

const CHANNEL = "__gpt_anticurse_v1__";
const DEFAULT_SETTINGS = { enabled: true, mode: "recent", maxDisplayMessages: 64, showGuardNotice: true };
const DOM_GATE = globalThis.CGAntiCurseDomReady;
let currentSettings = { ...DEFAULT_SETTINGS };
let settingsReady = false;
let lastStats = null;
let badge;
let hideTimer;
let renderQueuedForDomReady = false;

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
  if (DOM_GATE && !DOM_GATE.isReady()) {
    queueRenderAfterDomReady();
    return;
  }
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
  if (!settingsReady) return false;
  window.postMessage({ channel: CHANNEL, type: "settings", settings: currentSettings }, location.origin);
  return true;
}

chrome.storage.local.get(DEFAULT_SETTINGS).then((saved) => {
  currentSettings = { ...DEFAULT_SETTINGS, ...saved };
  settingsReady = true;
  postSettings();
  if (!currentSettings.showGuardNotice) removeBadge();
}).catch(() => {
  // The bounded product defaults are safer than pretending storage initialized.
  // Mark them authoritative only after the storage read itself has failed.
  settingsReady = true;
  postSettings();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (changes[key]) currentSettings[key] = changes[key].newValue;
  }
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
    // Do not satisfy MAIN world's startup barrier with an in-memory fallback.
    // The initial storage read posts once it has produced authoritative values.
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
