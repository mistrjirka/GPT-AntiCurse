/* Compact recovery status adapter for the transaction-aware stall watchdog. */
(() => {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const EVENT = "__gpt_anticurse_stall_status__";
  const BADGE_ID = "cg-conversation-guard-status";
  let status = null;
  let queued = false;
  let recoveryWasActive = false;
  let showGuardNotice = true;

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

  function ensureBadge() {
    let badge = document.getElementById(BADGE_ID);
    if (badge || !showGuardNotice) return badge;
    badge = document.createElement("div");
    badge.id = BADGE_ID;
    badge.title = "GPT AntiCurse";
    (document.body || document.documentElement).appendChild(badge);
    return badge;
  }

  function render() {
    queued = false;
    const text = label(status);
    if (!text) return;
    const badge = ensureBadge();
    if (!badge) return;
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
    const detail = event && event.detail;
    const active = !!(detail && detail.active === true);
    status = active ? { ...detail } : null;

    if (active) {
      recoveryWasActive = true;
      // recovery-status-ui is intentionally loaded before legacy content.js.
      // While recovery is active, this compact renderer exclusively owns the
      // badge so the old wide renderer cannot mutate it and feed the watchdog's
      // global MutationObserver back into another status publication.
      event.stopImmediatePropagation();
      scheduleRender();
      return;
    }

    if (recoveryWasActive) {
      // Let exactly one inactive transition reach content.js so the normal trim
      // badge can be restored. The DOM mutation caused by that restoration can
      // provoke another inactive status event; subsequent ones are suppressed.
      recoveryWasActive = false;
      return;
    }

    event.stopImmediatePropagation();
  }, true);

  const observer = new MutationObserver(() => {
    if (status) scheduleRender();
  });
  const start = () => observer.observe(document.body || document.documentElement, { childList: true, subtree: false });
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });

  ext.storage?.local?.get({ showGuardNotice: true }).then((saved) => {
    showGuardNotice = saved.showGuardNotice !== false;
    if (status && showGuardNotice) scheduleRender();
  }).catch((error) => {
    console.debug("[GPT AntiCurse] Recovery status setting unavailable", error);
  });
  ext.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes.showGuardNotice) return;
    showGuardNotice = changes.showGuardNotice.newValue !== false;
    if (status && showGuardNotice) scheduleRender();
  });
})();
