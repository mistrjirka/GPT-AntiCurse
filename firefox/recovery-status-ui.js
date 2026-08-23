/* Compact recovery status adapter for the transaction-aware stall watchdog. */
(() => {
  "use strict";

  const EVENT = "__gpt_anticurse_stall_status__";
  const BADGE_ID = "cg-conversation-guard-status";
  let status = null;
  let queued = false;

  function countdown(value) {
    const seconds = Math.max(0, Math.ceil((Number(value) || 0) / 1000));
    if (seconds >= 60) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    return `${seconds}s`;
  }

  function label(value) {
    if (!value || value.active !== true) return null;
    switch (value.phase) {
      case "blocked-pro": return "Pro off";
      case "blocked-unknown": return "model ?";
      case "loading": return value.remainingMs == null ? "loading" : `load ${countdown(value.remainingMs)}`;
      case "paused-draft": return "draft";
      case "checking": return "check";
      case "stopping": return "stopping";
      case "sending": return "sending";
      case "confirming": return "sent…";
      case "reloading": return "reload";
      case "restoring": return "resume";
      default: return value.longWaitBanner ? "resume now" : countdown(value.remainingMs);
    }
  }

  function render() {
    queued = false;
    const text = label(status);
    const badge = document.getElementById(BADGE_ID);
    if (!text || !badge) return;
    const phase = status.phase || (status.longWaitBanner ? "now" : "countdown");
    const currentState = badge.querySelector(".cg-state");
    if (badge.dataset.recoveryPhase === phase && currentState && currentState.textContent === text) return;

    badge.dataset.recoveryPhase = phase;
    const strong = document.createElement("strong");
    strong.textContent = "AC";
    const sep = document.createElement("span");
    sep.className = "cg-sep";
    sep.textContent = "·";
    const state = document.createElement("span");
    state.className = "cg-state";
    state.textContent = text;
    badge.replaceChildren(strong, sep, state);
  }

  function scheduleRender() {
    if (queued) return;
    queued = true;
    queueMicrotask(render);
  }

  window.addEventListener(EVENT, (event) => {
    status = event && event.detail && event.detail.active === true ? { ...event.detail } : null;
    scheduleRender();
  }, true);

  const observer = new MutationObserver(() => {
    if (status) scheduleRender();
  });
  const start = () => observer.observe(document.body || document.documentElement, { childList: true, subtree: false });
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
