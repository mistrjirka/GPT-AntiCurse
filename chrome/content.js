"use strict";

const CHANNEL = "__gpt_anticurse_v1__";
const DEFAULT_SETTINGS = { enabled: true, mode: "visible-history", maxDisplayMessages: 32 };
let currentSettings = { ...DEFAULT_SETTINGS };
let lastStats = null;
let badge;
let hideTimer;

function ensureBadge() {
  if (badge && document.documentElement.contains(badge)) return badge;
  badge = document.createElement("div");
  badge.id = "cg-conversation-guard-status";
  badge.title = "GPT AntiCurse";
  (document.body || document.documentElement).appendChild(badge);
  return badge;
}

function render(stats) {
  if (!stats) return;
  const el = ensureBadge();
  el.dataset.mode = stats.mode || "unknown";
  el.classList.remove("cg-compact");

  if (stats.mode === "trimmed") {
    const display = Number.isFinite(stats.displayBefore)
      ? `; ${stats.displayBefore} visible → ${stats.displayAfter}`
      : "";
    el.textContent = `AntiCurse: ${stats.mappingNodesBefore} → ${stats.mappingNodesAfter} nodes${display} (${stats.processingMs} ms)`;
    el.title = `Mode: ${stats.trimMode || stats.mode}\nTransport: ${stats.transport || "Chromium"}\nActive path roles: ${JSON.stringify(stats.roleCountsBefore || {})}\nExplicitly hidden: ${stats.explicitlyHiddenBefore || 0}`;
  } else if (stats.mode === "error") {
    el.textContent = "AntiCurse ERROR: original response passed through";
    el.title = stats.error || "Unknown interception error";
  } else {
    el.textContent = `AntiCurse: unchanged (${stats.reason || "small chat"})`;
  }

  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (el && el.dataset.mode === "trimmed") {
      el.textContent = "AntiCurse active";
      el.classList.add("cg-compact");
    }
  }, 9000);
}

function postSettings() {
  window.postMessage({ channel: CHANNEL, type: "settings", settings: currentSettings }, location.origin);
}

chrome.storage.local.get(DEFAULT_SETTINGS).then((saved) => {
  currentSettings = { ...DEFAULT_SETTINGS, ...saved };
  postSettings();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (changes[key]) currentSettings[key] = changes[key].newValue;
  }
  postSettings();
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
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "cg-get-stats") {
    sendResponse(lastStats);
    return false;
  }
  return false;
});
