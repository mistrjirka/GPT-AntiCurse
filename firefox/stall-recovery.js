/* Event-driven recovery for ChatGPT runs that remain "streaming" but stop making visible progress. */
(() => {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const SESSION_AUTH = globalThis.CGAntiCurseSessionAuth;
  const DEFAULTS = Object.freeze({
    stallRecoveryEnabled: true,
    stallRecoveryTimeoutSeconds: 120,
    stallRecoveryToolTimeoutSeconds: 300,
    stallRecoveryGraceSeconds: 10
  });
  const RESUME_KEY = "__gpt_anticurse_stall_resume_v1__";
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const TURN_CONTAINER_SELECTOR = '[data-turn-id-container]';
  const STREAMING_SELECTOR = '[data-streaming-response-status]';
  const STOP_SELECTOR = '#composer-submit-button[data-testid="stop-button"]';
  const SUBMIT_SELECTOR = '#composer-submit-button:not([data-testid="stop-button"])';
  const COMPOSER_SELECTOR = '#prompt-textarea[contenteditable="true"]';

  let settings = { ...DEFAULTS };
  let turnList = null;
  let turnListObserver = null;
  let shellObservers = [];
  let shellRefreshRaf = 0;
  let activeTurn = null;
  let activityObserver = null;
  let activeTurnKey = null;
  let lastActivityAt = 0;
  let stallTimer = null;
  let recoveryGeneration = 0;
  let attemptedTurnKey = null;
  const attemptedTurns = new Set();
  let visibilityListenerInstalled = false;
  let discoveryObserver = null;
  let discoveryTimer = null;

  function clampSeconds(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function applySettings(next) {
    if (!next || typeof next !== "object") return;
    if (typeof next.stallRecoveryEnabled === "boolean") settings.stallRecoveryEnabled = next.stallRecoveryEnabled;
    settings.stallRecoveryTimeoutSeconds = clampSeconds(next.stallRecoveryTimeoutSeconds, settings.stallRecoveryTimeoutSeconds, 60, 1800);
    settings.stallRecoveryToolTimeoutSeconds = clampSeconds(next.stallRecoveryToolTimeoutSeconds, settings.stallRecoveryToolTimeoutSeconds, 120, 3600);
    settings.stallRecoveryGraceSeconds = clampSeconds(next.stallRecoveryGraceSeconds, settings.stallRecoveryGraceSeconds, 0, 60);
  }

  function clearTimer() {
    if (stallTimer !== null) clearTimeout(stallTimer);
    stallTimer = null;
  }

  function conversationId() {
    const match = location.pathname.match(/^\/(?:c|branch)\/([^/?#]+)/);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch { return null; }
  }

  function stopButton() { return document.querySelector(STOP_SELECTOR); }
  function composer() { return document.querySelector(COMPOSER_SELECTOR); }
  function draftText() { const node = composer(); return node ? (node.textContent || "").trim() : ""; }

  function hasAttachmentDraft() {
    const input = composer();
    const form = input && input.closest("form");
    if (!form) return false;
    return !!form.querySelector(
      '[data-testid*="attachment"]:not(input), [data-testid*="upload-preview"]:not(input), [data-testid*="file-thumbnail"]:not(input), [data-testid*="file-pill"]:not(input)'
    );
  }

  function hasUserDraft() { return !!draftText() || hasAttachmentDraft(); }
  function composerContainsOnlyNudge() { return draftText() === "." && !hasAttachmentDraft(); }

  function nodeHasMeaningfulText(node) {
    if (!node) return false;
    if (node.nodeType === Node.TEXT_NODE) return !!String(node.nodeValue || "").trim();
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.matches("script, style")) return false;
    return !!String(node.textContent || "").trim();
  }

  function mutationIsMeaningful(record) {
    if (record.type === "characterData") return nodeHasMeaningfulText(record.target);
    if (record.type === "attributes") {
      return record.attributeName === "data-state" || record.attributeName === "aria-busy" || record.attributeName === "data-streaming-response-status";
    }
    if (record.type !== "childList") return false;
    for (const node of record.addedNodes) if (nodeHasMeaningfulText(node)) return true;
    for (const node of record.removedNodes) if (nodeHasMeaningfulText(node)) return true;
    return false;
  }

  function runningTool(turn = activeTurn) {
    if (!turn) return false;
    for (const shimmer of turn.querySelectorAll(".loading-shimmer-tertiary")) {
      const row = shimmer.closest("div");
      if (row && row.querySelector('[data-testid="cot-v5-tool-icon-pile"], [data-testid*="tool-icon"]')) return true;
      const parent = shimmer.parentElement && shimmer.parentElement.parentElement;
      if (parent && parent.querySelector('[data-testid="cot-v5-tool-icon-pile"], [data-testid*="tool-icon"]')) return true;
    }
    return !!turn.querySelector('[aria-busy="true"][data-testid*="tool"], [data-state="running"][data-testid*="tool"]');
  }

  function thresholdMs() {
    return (runningTool() ? settings.stallRecoveryToolTimeoutSeconds : settings.stallRecoveryTimeoutSeconds) * 1000;
  }

  function turnKey(turn) {
    if (!turn) return null;
    const section = turn.matches(TURN_SELECTOR) ? turn : turn.querySelector(TURN_SELECTOR);
    return (section && (section.getAttribute("data-turn-id") || section.getAttribute("data-testid"))) ||
      turn.getAttribute("data-turn-id-container") || null;
  }

  function scheduleStallCheck(delayOverride) {
    clearTimer();
    if (!settings.stallRecoveryEnabled || !activeTurn || !stopButton()) return;
    const elapsed = Date.now() - lastActivityAt;
    const delay = delayOverride == null ? Math.max(0, thresholdMs() - elapsed) : Math.max(0, delayOverride);
    stallTimer = setTimeout(checkForStall, delay);
  }

  function markActivity() {
    lastActivityAt = Date.now();
    recoveryGeneration++;
    scheduleStallCheck();
  }

  function observeActiveTurn(turn) {
    if (activeTurn === turn) return;
    if (activityObserver) activityObserver.disconnect();
    activityObserver = null;
    activeTurn = turn || null;
    activeTurnKey = turnKey(activeTurn);
    clearTimer();
    recoveryGeneration++;
    if (!activeTurn) return;

    lastActivityAt = Date.now();
    activityObserver = new MutationObserver((records) => {
      if (records.some(mutationIsMeaningful)) markActivity();
    });
    activityObserver.observe(activeTurn, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-state", "aria-busy", "data-streaming-response-status"]
    });
    scheduleStallCheck();
  }

  function findActiveTurn() {
    if (!turnList || !turnList.isConnected) return null;
    const children = Array.from(turnList.children);
    for (let index = children.length - 1; index >= 0; index--) {
      const wrapper = children[index];
      if (!wrapper.matches(TURN_CONTAINER_SELECTOR)) continue;
      if (wrapper.querySelector(STREAMING_SELECTOR)) return wrapper;
    }
    return null;
  }

  function syncActiveTurn() {
    const next = findActiveTurn();
    if (next !== activeTurn) observeActiveTurn(next);
    else if (activeTurn && !stopButton()) observeActiveTurn(null);
  }

  function disconnectShellObservers() {
    for (const observer of shellObservers) observer.disconnect();
    shellObservers = [];
    if (shellRefreshRaf) cancelAnimationFrame(shellRefreshRaf);
    shellRefreshRaf = 0;
  }

  function scheduleShellRefresh() {
    if (shellRefreshRaf) return;
    shellRefreshRaf = requestAnimationFrame(() => {
      shellRefreshRaf = 0;
      if (turnList && turnList.isConnected) return;
      turnList = null;
      scheduleDiscovery();
    });
  }

  function installShellObservers() {
    disconnectShellObservers();
    if (!turnList || !turnList.isConnected) return;
    const main = document.querySelector("#main") || document.body;
    let node = turnList.parentElement;
    while (node && node !== document.documentElement) {
      const observer = new MutationObserver(scheduleShellRefresh);
      observer.observe(node, { childList: true });
      shellObservers.push(observer);
      if (node === main || node === document.body) break;
      node = node.parentElement;
    }
  }

  function installTurnListObserver() {
    const sections = document.querySelectorAll(TURN_SELECTOR);
    const section = sections.length ? sections[sections.length - 1] : null;
    const wrapper = section && section.closest(TURN_CONTAINER_SELECTOR);
    const nextList = wrapper && wrapper.parentElement;
    if (!nextList) return false;
    if (nextList === turnList && turnListObserver) {
      syncActiveTurn();
      return true;
    }
    if (turnListObserver) turnListObserver.disconnect();
    turnList = nextList;
    turnListObserver = new MutationObserver(syncActiveTurn);
    turnListObserver.observe(turnList, { childList: true });
    installShellObservers();
    syncActiveTurn();
    return true;
  }

  function clearDiscovery() {
    if (discoveryObserver) discoveryObserver.disconnect();
    if (discoveryTimer !== null) clearTimeout(discoveryTimer);
    discoveryObserver = null;
    discoveryTimer = null;
  }

  function scheduleDiscovery() {
    if (!settings.stallRecoveryEnabled) return;
    if (installTurnListObserver()) { clearDiscovery(); return; }
    if (discoveryObserver) return;
    const root = document.documentElement;
    if (!root) return;
    discoveryObserver = new MutationObserver(() => {
      if (!installTurnListObserver()) return;
      clearDiscovery();
    });
    discoveryObserver.observe(root, { childList: true, subtree: true });
    discoveryTimer = setTimeout(clearDiscovery, 10_000);
  }

  async function streamStatus(id) {
    if (!id || !SESSION_AUTH || typeof SESSION_AUTH.resolveAccessToken !== "function") return null;
    const auth = await SESSION_AUTH.resolveAccessToken({ isCurrent: () => conversationId() === id });
    if (!auth.ok || conversationId() !== id) return null;
    try {
      const response = await fetch(`${location.origin}/backend-api/conversation/${encodeURIComponent(id)}/stream_status`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json", authorization: `Bearer ${auth.accessToken}` }
      });
      if (!response.ok) return null;
      const data = await response.json();
      return typeof data?.status === "string" ? data.status : null;
    } catch {
      return null;
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState !== "visible") return;
    removeVisibilityWakeup();
    if (activeTurn) scheduleStallCheck(0);
  }

  function installVisibilityWakeup() {
    if (visibilityListenerInstalled) return;
    visibilityListenerInstalled = true;
    document.addEventListener("visibilitychange", onVisibilityChange, { passive: true });
  }

  function removeVisibilityWakeup() {
    if (!visibilityListenerInstalled) return;
    visibilityListenerInstalled = false;
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }

  function waitForCondition(test, root, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let observer = null;
      let timeout = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (observer) observer.disconnect();
        if (timeout !== null) clearTimeout(timeout);
        resolve(value);
      };
      try { if (test()) { finish(true); return; } } catch { /* fail open */ }
      observer = new MutationObserver(() => {
        try { if (test()) finish(true); } catch { /* keep waiting */ }
      });
      observer.observe(root || document.documentElement, { childList: true, subtree: true, attributes: true });
      timeout = setTimeout(() => finish(false), timeoutMs);
    });
  }

  function setResumeMarker(id) {
    try {
      sessionStorage.setItem(RESUME_KEY, JSON.stringify({ id, action: "send-dot", expiresAt: Date.now() + 90_000 }));
      return true;
    } catch { return false; }
  }

  function takeResumeMarker() {
    try {
      const raw = sessionStorage.getItem(RESUME_KEY);
      sessionStorage.removeItem(RESUME_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.action !== "send-dot" || parsed.id !== conversationId()) return null;
      if (!Number.isFinite(parsed.expiresAt) || parsed.expiresAt < Date.now()) return null;
      return parsed;
    } catch { return null; }
  }

  function replaceComposerWithNudge(node) {
    if (!node || !node.isConnected || (node.textContent || "").trim()) return false;
    node.focus({ preventScroll: true });
    const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "." });
    if (!node.dispatchEvent(before)) return false;
    const paragraph = document.createElement("p");
    paragraph.textContent = ".";
    node.replaceChildren(paragraph);
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "." }));
    return (node.textContent || "").trim() === ".";
  }

  async function sendNudge() {
    if (hasUserDraft()) return false;
    let submit = document.querySelector(SUBMIT_SELECTOR);
    if (!submit || submit.disabled || submit.getAttribute("aria-disabled") === "true") return false;
    if (!replaceComposerWithNudge(composer())) return false;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    // The user can type during this frame. Never send if the composer changed
    // from AntiCurse's exact fixed nudge or gained an attachment.
    if (!composerContainsOnlyNudge()) return false;
    submit = document.querySelector(SUBMIT_SELECTOR);
    if (!submit || submit.disabled || submit.getAttribute("aria-disabled") === "true") return false;
    submit.click();
    return waitForCondition(
      () => !!stopButton() || !!document.querySelector(`${TURN_CONTAINER_SELECTOR} ${STREAMING_SELECTOR}`),
      document.documentElement,
      8_000
    );
  }

  async function recoverStall(id, key, generation) {
    const identity = `${id || ""}\u001f${key || ""}`;
    if (generation !== recoveryGeneration || key !== activeTurnKey || attemptedTurns.has(identity)) return;
    if (hasUserDraft()) { scheduleStallCheck(30_000); return; }
    const stop = stopButton();
    if (!stop) return;
    attemptedTurns.add(identity);
    if (attemptedTurns.size > 256) attemptedTurns.delete(attemptedTurns.values().next().value);
    attemptedTurnKey = key;
    stop.click();
    const stopped = await waitForCondition(() => !stopButton(), document.documentElement, 10_000);
    if (!stopped || hasUserDraft()) return;
    if (await sendNudge()) return;
    // A stopped run can leave an empty composer whose submit control is still
    // absent/disabled. Reload only in that clearly wedged, still-empty state.
    // If sendNudge inserted anything or the user typed meanwhile, do nothing.
    const input = composer();
    const submit = document.querySelector(SUBMIT_SELECTOR);
    const submitUsable = !!submit && !submit.disabled && submit.getAttribute("aria-disabled") !== "true";
    if (!input || !input.isConnected || stopButton() || draftText() || hasAttachmentDraft() || submitUsable) return;
    if (setResumeMarker(id)) location.reload();
  }

  async function checkForStall() {
    stallTimer = null;
    if (!settings.stallRecoveryEnabled || !activeTurn || !stopButton()) return;
    if (document.visibilityState !== "visible") { installVisibilityWakeup(); return; }
    const elapsed = Date.now() - lastActivityAt;
    const threshold = thresholdMs();
    if (elapsed < threshold) { scheduleStallCheck(threshold - elapsed); return; }
    if (hasUserDraft()) { scheduleStallCheck(30_000); return; }

    const id = conversationId();
    const key = activeTurnKey;
    const generation = recoveryGeneration;
    if (await streamStatus(id) !== "IS_STREAMING") return;
    if (generation !== recoveryGeneration || key !== activeTurnKey) return;

    const graceMs = settings.stallRecoveryGraceSeconds * 1000;
    if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs));
    if (generation !== recoveryGeneration || key !== activeTurnKey) return;
    if (Date.now() - lastActivityAt < threshold || hasUserDraft() || !stopButton()) return;
    // Always require a second exact backend confirmation immediately before
    // intervention, even if a future configuration sets the grace to zero.
    if (await streamStatus(id) !== "IS_STREAMING") return;
    if (generation !== recoveryGeneration || key !== activeTurnKey) return;
    await recoverStall(id, key, generation);
  }

  async function resumeAfterReload(marker) {
    if (!marker || !settings.stallRecoveryEnabled) return;
    const ready = await waitForCondition(
      () => !!composer() && !!document.querySelector(SUBMIT_SELECTOR) && !stopButton(),
      document.documentElement,
      20_000
    );
    if (!ready || hasUserDraft()) return;
    await sendNudge();
  }

  function teardown() {
    clearTimer();
    clearDiscovery();
    removeVisibilityWakeup();
    disconnectShellObservers();
    if (activityObserver) activityObserver.disconnect();
    if (turnListObserver) turnListObserver.disconnect();
    activityObserver = null;
    turnListObserver = null;
    activeTurn = null;
    activeTurnKey = null;
    turnList = null;
  }

  async function start() {
    let stored = {};
    try { stored = await ext.storage.local.get(DEFAULTS); } catch { /* defaults are safe */ }
    applySettings(stored);

    ext.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local") return;
      const next = {};
      for (const key of Object.keys(DEFAULTS)) if (changes[key]) next[key] = changes[key].newValue;
      if (!Object.keys(next).length) return;
      applySettings(next);
      if (!settings.stallRecoveryEnabled) teardown();
      else scheduleDiscovery();
    });

    const resume = takeResumeMarker();
    if (settings.stallRecoveryEnabled) scheduleDiscovery();
    if (resume) resumeAfterReload(resume);
  }

  globalThis.CGAntiCurseStallRecovery = {
    debug() {
      return {
        enabled: settings.stallRecoveryEnabled,
        conversationId: conversationId(),
        activeTurn: !!activeTurn,
        activeTurnKey,
        runningTool: runningTool(),
        lastActivityAt,
        attemptedTurnKey,
        attemptedTurnCount: attemptedTurns.size,
        timeoutSeconds: settings.stallRecoveryTimeoutSeconds,
        toolTimeoutSeconds: settings.stallRecoveryToolTimeoutSeconds,
        turnListObserver: !!turnListObserver,
        shellObserverCount: shellObservers.length,
        discoveryObserver: !!discoveryObserver
      };
    }
  };

  start();
})();
