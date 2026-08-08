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

function pctRemoved(stats) {
  const before = Number(stats.mappingNodesBefore) || 0;
  const after = Number(stats.mappingNodesAfter) || 0;
  return before > 0 ? Math.round(Math.max(0, Math.min(100, ((before - after) / before) * 100))) : 0;
}

function render(stats) {
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
      if (el && el.dataset.mode === "trimmed") {
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

browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === "cg-stats") render(message.stats);
});

browser.runtime.sendMessage({ type: "cg-get-stats" }).then(render).catch(() => {});
