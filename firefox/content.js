"use strict";

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
    if (stats.roleCountsBefore) {
      el.title = `Mode: ${stats.trimMode || stats.mode}\nTransport: ${stats.transport || "Firefox"}\nActive path roles: ${JSON.stringify(stats.roleCountsBefore)}\nExplicitly hidden: ${stats.explicitlyHiddenBefore || 0}`;
    }
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

browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === "cg-stats") render(message.stats);
});

browser.runtime.sendMessage({ type: "cg-get-stats" }).then(render).catch(() => {});
