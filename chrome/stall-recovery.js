/* Event-driven recovery for ChatGPT runs that remain "streaming" but stop making visible progress. */
(() => {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const SESSION_AUTH = globalThis.CGAntiCurseSessionAuth;
  const DEFAULTS = Object.freeze({ stallRecoveryEnabled: true });
  const STALL_TIMEOUT_MS = 120_000;
  const STOP_SETTLE_TIMEOUT_MS = 180_000;
  const SEND_READY_TIMEOUT_MS = 180_000;
  const SEND_CONFIRM_TIMEOUT_MS = 30_000;
  const RECOVERY_RELOAD_TIMEOUT_MS = 120_000;
  const RECOVERY_RELOAD_READY_TIMEOUT_MS = 30_000;
  const STOP_BACKEND_POLL_MS = 1_500;
  const MAX_RECOVERY_RELOADS = 1;
  const STALL_STATUS_EVENT = "__gpt_anticurse_stall_status__";
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const TURN_CONTAINER_SELECTOR = '[data-turn-id-container]';
  const STREAMING_SELECTOR = '[data-streaming-response-status]';
  const STOP_SELECTOR = '#composer-submit-button[data-testid="stop-button"]';
  const SUBMIT_SELECTOR = '#composer-submit-button:not([data-testid="stop-button"])';
  const COMPOSER_SELECTOR = '#prompt-textarea[contenteditable="true"]';
  const COMPOSER_INPUT = globalThis.CGAntiCurseComposerInput;
  const RELOAD_STATE = globalThis.CGAntiCurseRecoveryReloadState;

  let settings = { ...DEFAULTS };
  let turnList = null;
  let turnListObserver = null;
  let shellObservers = [];
  let shellRefreshScheduled = false;
  let activeTurn = null;
  let activityObserver = null;
  let activeTurnKey = null;
  let lastActivityAt = 0;
  let stallTimer = null;
  let recoveryGeneration = 0;
  let attemptedTurnKey = null;
  const attemptedTurns = new Set();
  const recoveringTurns = new Set();
  let discoveryObserver = null;
  let discoveryTimer = null;
  let countdownUiTimer = null;
  let recoveryPhase = null;
  let recoveryStartedAt = 0;
  let lastRecoveryFinishedAt = 0;
  let lastRecoveryResult = null;
  let lastRecoveryFailure = null;
  let loadingStartedAt = 0;
  let recoveryReloadCount = 0;
  let lastRecoveryReloadReason = null;
  let lastNudgeStage = null;
  let lastNudgeInsertMethod = null;
  let lastNudgeInsertAccepted = null;
  let lastNudgeSubmitReady = null;
  let lastNudgeGuardArmed = null;
  let lastNudgeClickBlocked = null;
  let lastNudgeConfirmed = null;
  let recoveryReloadScheduled = false;
  let lastStopSettlementSource = null;
  let lastStopBackendStatus = null;

  function applySettings(next) {
    if (!next || typeof next !== "object") return;
    if (typeof next.stallRecoveryEnabled === "boolean") settings.stallRecoveryEnabled = next.stallRecoveryEnabled;
  }

  function clearTimer() {
    if (stallTimer !== null) clearTimeout(stallTimer);
    stallTimer = null;
  }

  function clearCountdownUiTimer() {
    if (countdownUiTimer !== null) clearTimeout(countdownUiTimer);
    countdownUiTimer = null;
  }

  function recoveryModelState() {
    const guard = globalThis.CGAntiCurseProRecoveryGuard;
    if (!guard || typeof guard.activeRecoveryState !== "function") {
      return { decision: "unknown", autoRecoveryAllowed: false, detectionSource: "guard-unavailable" };
    }
    try {
      const state = guard.activeRecoveryState();
      return state && typeof state === "object"
        ? state
        : { decision: "unknown", autoRecoveryAllowed: false, detectionSource: "guard-invalid-state" };
    } catch (error) {
      console.debug("[GPT AntiCurse] Pro recovery guard state unavailable", error);
      return { decision: "unknown", autoRecoveryAllowed: false, detectionSource: "guard-error" };
    }
  }

  function recoveryNudgeModelState(turnKey) {
    const guard = globalThis.CGAntiCurseProRecoveryGuard;
    if (!guard || typeof guard.recoveryNudgeState !== "function") return recoveryModelState();
    try {
      const state = guard.recoveryNudgeState(turnKey);
      return state && typeof state === "object" ? state : recoveryModelState();
    } catch {
      return recoveryModelState();
    }
  }

  function armRecoveryNudge(turnKey) {
    const guard = globalThis.CGAntiCurseProRecoveryGuard;
    if (!guard || typeof guard.armRecoveryNudge !== "function") return { autoRecoveryAllowed: false, decision: "unknown" };
    try {
      const state = guard.armRecoveryNudge(turnKey);
      return state && typeof state === "object" ? state : { autoRecoveryAllowed: false, decision: "unknown" };
    } catch {
      return { autoRecoveryAllowed: false, decision: "unknown" };
    }
  }

  function recoveryGuardBlockedClicks() {
    const guard = globalThis.CGAntiCurseProRecoveryGuard;
    if (!guard || typeof guard.debug !== "function") return null;
    try {
      const value = Number(guard.debug()?.blockedClicks);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  function recoveryRemainingMs() {
    if (recoveringTurns.size || recoveryPhase) return null;
    if (!activeTurn || !stopButton()) return null;
    if (recoveryModelState().autoRecoveryAllowed !== true) return null;
    if (hasLongWaitBanner(activeTurn)) return 0;
    if (shellLoading() || preOutputLoading(activeTurn)) {
      const since = loadingStartedAt || lastActivityAt || Date.now();
      return Math.max(0, RECOVERY_RELOAD_TIMEOUT_MS - (Date.now() - since));
    }
    return Math.max(0, thresholdMs() - (Date.now() - lastActivityAt));
  }

  function publishRecoveryStatus() {
    clearCountdownUiTimer();
    const id = conversationId();
    const transactionActive = recoveringTurns.size > 0;
    const active = settings.stallRecoveryEnabled && (transactionActive || (!!activeTurn && !!stopButton()));
    if (!active) {
      if (!transactionActive) recoveryPhase = null;
      window.dispatchEvent(new CustomEvent(STALL_STATUS_EVENT, { detail: { active: false, conversationId: id } }));
      return;
    }

    const modelState = recoveryModelState();
    const modelBlocked = modelState.autoRecoveryAllowed !== true;
    const longWaitBanner = hasLongWaitBanner(activeTurn);
    const loading = shellLoading() || preOutputLoading(activeTurn);
    const draftBlocked = hasUserDraft();
    const remainingMs = recoveryRemainingMs();
    const phase = recoveryPhase ||
      (modelBlocked
        ? (modelState.decision === "pro" ? "blocked-pro" : "blocked-unknown")
        : draftBlocked ? "paused-draft"
        : longWaitBanner ? "checking"
        : loading ? "loading"
        : "countdown");

    window.dispatchEvent(new CustomEvent(STALL_STATUS_EVENT, { detail: {
      active: true,
      conversationId: id,
      phase,
      remainingMs,
      longWaitBanner,
      draftBlocked,
      recoveryDecision: modelState.decision || "unknown",
      recoveryDetectionSource: modelState.detectionSource || null
    } }));

    // Recovery itself stays deadline/event-driven. This timer only refreshes the
    // visible countdown while a positively identified non-Pro streaming turn exists.
    if (!recoveryPhase && !modelBlocked && !longWaitBanner) {
      countdownUiTimer = setTimeout(publishRecoveryStatus, 1000);
    }
  }

  function setRecoveryPhase(phase) {
    recoveryPhase = phase || null;
    publishRecoveryStatus();
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

  function shellLoading() {
    const input = composer();
    const form = (input && input.closest('form[data-type="unified-composer"]')) || document.querySelector('form[data-type="unified-composer"]');
    if (form && (form.hasAttribute("inert") || form.inert === true)) return true;
    return !!(activeTurn && !activeTurn.isConnected);
  }

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

  function hasLongWaitBanner(turn = activeTurn) {
    if (!turn) return false;
    for (const shimmer of turn.querySelectorAll(`${STREAMING_SELECTOR} .loading-shimmer-tertiary`)) {
      const text = String(shimmer.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (text.includes("our systems are thinking a bit more about this request")) return true;
      const status = shimmer.closest(STREAMING_SELECTOR);
      if (status && status.querySelector('a[href*="help.openai.com/articles/20001326"], a[href*="/articles/20001326"]')) return true;
    }
    return false;
  }

  function hasAssistantOutput(turn = activeTurn) {
    if (!turn) return false;
    const section = turn.matches?.('[data-turn="assistant"], [data-testid^="conversation-turn-"][data-turn="assistant"]')
      ? turn
      : turn.querySelector?.('[data-turn="assistant"], [data-testid^="conversation-turn-"][data-turn="assistant"]');
    const scope = section || turn;
    for (const message of scope.querySelectorAll('[data-message-author-role="assistant"], .markdown, [data-conversation-screenshot-content] .markdown')) {
      if (String(message.textContent || "").trim()) return true;
      if (message.querySelector?.("img, video, audio, pre, code, table")) return true;
    }
    return false;
  }

  function preOutputLoading(turn = activeTurn) {
    return !!turn && !!turn.querySelector(STREAMING_SELECTOR) && !hasLongWaitBanner(turn) && !hasAssistantOutput(turn);
  }

  function thresholdMs() {
    return STALL_TIMEOUT_MS;
  }

  function turnKey(turn) {
    if (!turn) return null;
    const section = turn.matches(TURN_SELECTOR) ? turn : turn.querySelector(TURN_SELECTOR);
    return (section && (section.getAttribute("data-turn-id") || section.getAttribute("data-testid"))) ||
      turn.getAttribute("data-turn-id-container") || null;
  }

  function scheduleStallCheck(delayOverride) {
    clearTimer();
    if (!settings.stallRecoveryEnabled || !activeTurn || !stopButton()) { publishRecoveryStatus(); return; }
    if (recoveryModelState().autoRecoveryAllowed !== true) { publishRecoveryStatus(); return; }
    const loading = shellLoading() || preOutputLoading(activeTurn);
    if (loading && !loadingStartedAt) loadingStartedAt = Date.now();
    const elapsed = loading ? Date.now() - loadingStartedAt : Date.now() - lastActivityAt;
    const deadline = loading ? RECOVERY_RELOAD_TIMEOUT_MS : thresholdMs();
    const delay = delayOverride == null
      ? (hasLongWaitBanner(activeTurn) ? 0 : Math.max(0, deadline - elapsed))
      : Math.max(0, delayOverride);
    stallTimer = setTimeout(checkForStall, delay);
    publishRecoveryStatus();
  }

  function markActivity() {
    // DOM churn caused by our own Stop → Send transaction is not new model
    // progress and must not restart the stall deadline or cancel the transaction.
    if (recoveringTurns.size) { publishRecoveryStatus(); return; }
    lastActivityAt = Date.now();
    if (!shellLoading() && !preOutputLoading(activeTurn)) loadingStartedAt = 0;
    recoveryGeneration++;
    recoveryPhase = null;
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
    recoveryPhase = null;
    if (!activeTurn) { publishRecoveryStatus(); return; }

    lastActivityAt = Date.now();
    loadingStartedAt = (shellLoading() || preOutputLoading(activeTurn)) ? lastActivityAt : 0;
    activityObserver = new MutationObserver((records) => {
      // This explicit ChatGPT long-wait UI is a stall signal, not progress.
      // React inserting/animating it must not restart the ordinary deadline.
      if (hasLongWaitBanner(activeTurn)) { scheduleStallCheck(0); return; }
      if (shellLoading() || preOutputLoading(activeTurn)) {
        if (!loadingStartedAt) loadingStartedAt = Date.now();
        scheduleStallCheck();
        return;
      }
      loadingStartedAt = 0;
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
    // Use the same live-document search as the Pro safety guard. ChatGPT can
    // replace/reparent the turn list while a request is running, so restricting
    // discovery to a previously captured parent can miss the new request-* turn.
    const turns = document.querySelectorAll(TURN_CONTAINER_SELECTOR);
    for (let index = turns.length - 1; index >= 0; index--) {
      if (turns[index].querySelector(STREAMING_SELECTOR)) return turns[index];
    }
    return null;
  }

  function syncActiveTurn() {
    // Once recovery owns a turn, ChatGPT is allowed to remove/reparent its
    // streaming DOM while Stop settles. Keep that transaction pinned to the
    // original turn until it either sends the nudge or fails safely.
    if (recoveringTurns.size) return;
    const next = findActiveTurn();
    if (next !== activeTurn) observeActiveTurn(next);
    else if (activeTurn && !stopButton()) observeActiveTurn(null);
  }

  function disconnectShellObservers() {
    for (const observer of shellObservers) observer.disconnect();
    shellObservers = [];
    shellRefreshScheduled = false;
  }

  function scheduleShellRefresh() {
    if (shellRefreshScheduled) return;
    shellRefreshScheduled = true;
    queueMicrotask(() => {
      shellRefreshScheduled = false;
      // Re-run global live-turn discovery even when the previously captured list
      // is still connected. ChatGPT can replace/reparent the streaming request
      // elsewhere while a background tab is virtualized. Microtasks continue to
      // run in hidden tabs; requestAnimationFrame does not.
      syncActiveTurn();
      if (turnList && turnList.isConnected) return;
      if (activeTurn && !activeTurn.isConnected) observeActiveTurn(null);
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
    turnListObserver.observe(turnList, { childList: true, subtree: true });
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

  function turnsByKey(key) {
    if (!key) return [];
    const matches = [];
    for (const turn of document.querySelectorAll(TURN_CONTAINER_SELECTOR)) {
      if (turnKey(turn) === key) matches.push(turn);
    }
    return matches;
  }

  function latestAssistantTurn() {
    const turns = document.querySelectorAll(TURN_CONTAINER_SELECTOR);
    for (let index = turns.length - 1; index >= 0; index--) {
      const turn = turns[index];
      if (turn.parentElement?.closest?.(TURN_CONTAINER_SELECTOR)) continue;
      if (turn.querySelector('[data-turn="assistant"], section[data-turn="assistant"]')) return turn;
    }
    return null;
  }

  function latestAssistantShowsStoppedState(key) {
    if (stopButton()) return false;
    const latest = latestAssistantTurn();
    if (!latest || latest.querySelector(STREAMING_SELECTOR)) return false;
    const latestKey = turnKey(latest);
    // ChatGPT can remount the stopped assistant turn under the same request key.
    // Prefer that exact relation when available. If the key changed during the
    // remount, require all currently rendered copies of the original key to be
    // non-streaming before accepting the newest idle assistant turn.
    if (!key || latestKey === key) return true;
    const copies = turnsByKey(key);
    return copies.length > 0 && copies.every((turn) => !turn.querySelector(STREAMING_SELECTOR));
  }

  function originalTurnStillStreaming(key) {
    const copies = turnsByKey(key);
    return copies.some((turn) => !!turn.querySelector(STREAMING_SELECTOR));
  }

  async function waitForStopSettlement(id, key) {
    // Real ChatGPT can keep stale streaming markers on older/remounted turns
    // after a Stop has already completed. The newest idle assistant is accepted
    // immediately, and once Stop disappears we poll backend stream_status rather
    // than waiting for a stale DOM marker to vanish.
    const deadline = Date.now() + Math.min(STOP_SETTLE_TIMEOUT_MS, RECOVERY_RELOAD_TIMEOUT_MS);
    lastStopSettlementSource = null;
    lastStopBackendStatus = null;

    while (Date.now() < deadline) {
      if (!settings.stallRecoveryEnabled || conversationId() !== id) return false;
      if (latestAssistantShowsStoppedState(key)) {
        lastStopSettlementSource = "latest-assistant-idle";
        return true;
      }

      const stopPresent = !!stopButton();
      const domStreaming = originalTurnStillStreaming(key);
      if (!stopPresent && !domStreaming) {
        lastStopSettlementSource = "dom";
        return true;
      }

      if (!stopPresent) {
        const status = await streamStatus(id);
        lastStopBackendStatus = status;
        if (status !== null && status !== "IS_STREAMING") {
          lastStopSettlementSource = "backend";
          return true;
        }
      }

      const remaining = Math.max(0, deadline - Date.now());
      if (!remaining) break;
      await waitForCondition(
        () => latestAssistantShowsStoppedState(key) ||
          (!stopButton() && !originalTurnStillStreaming(key)) ||
          (!!stopButton() !== stopPresent),
        document.documentElement,
        Math.min(STOP_BACKEND_POLL_MS, remaining)
      );
    }

    // One final backend read closes the race where cancellation completed just
    // as the two-minute recovery-operation ceiling expired.
    if (!stopButton()) {
      const status = await streamStatus(id);
      lastStopBackendStatus = status;
      if (status !== null && status !== "IS_STREAMING") {
        lastStopSettlementSource = "backend-final";
        return true;
      }
    }
    lastStopSettlementSource = "timeout";
    return false;
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

  function replaceComposerWithNudge(node) {
    if (!node || !node.isConnected || (node.textContent || "").trim()) return false;
    lastNudgeStage = "insert-nudge";
    lastNudgeInsertMethod = null;
    lastNudgeInsertAccepted = false;
    if (COMPOSER_INPUT && typeof COMPOSER_INPUT.insertText === "function") {
      try {
        if (COMPOSER_INPUT.insertText(node, ".")) {
          lastNudgeInsertMethod = "native-editor";
          lastNudgeInsertAccepted = true;
          return true;
        }
      } catch { /* compatibility fallback below */ }
    }
    // Compatibility fallback for simple contenteditable implementations. Modern
    // ChatGPT normally takes the native-editor path above so its controlled
    // editor state, not only the DOM, receives the continuation nudge.
    lastNudgeInsertMethod = "dom-input-fallback";
    node.focus({ preventScroll: true });
    const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "." });
    if (!node.dispatchEvent(before)) return false;
    const paragraph = document.createElement("p");
    paragraph.textContent = ".";
    node.replaceChildren(paragraph);
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "." }));
    lastNudgeInsertAccepted = (node.textContent || "").trim() === ".";
    return lastNudgeInsertAccepted;
  }

  function clearSyntheticNudge() {
    const node = composer();
    if (!node || !node.isConnected || !composerContainsOnlyNudge()) return false;
    if (COMPOSER_INPUT && typeof COMPOSER_INPUT.clearExactText === "function") {
      try { if (COMPOSER_INPUT.clearExactText(node, ".")) return true; } catch { /* fallback below */ }
    }
    const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward", data: null });
    if (!node.dispatchEvent(before)) return false;
    node.replaceChildren();
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
    return !(node.textContent || "").trim();
  }

  async function sendNudge(originalKey) {
    lastNudgeStage = "starting";
    lastNudgeSubmitReady = null;
    lastNudgeGuardArmed = null;
    lastNudgeClickBlocked = null;
    lastNudgeConfirmed = null;
    if (hasUserDraft()) { lastNudgeStage = "blocked-user-draft"; return false; }
    const input = composer();
    if (!replaceComposerWithNudge(input)) { lastNudgeStage = "insert-rejected"; return false; }
    // Yield out of the input event without relying on requestAnimationFrame:
    // rAF is suspended for background tabs, while a microtask still runs.
    await new Promise((resolve) => queueMicrotask(resolve));
    // The user can type during this transition. Never send if the composer changed
    // from AntiCurse's exact fixed nudge or gained an attachment.
    if (!composerContainsOnlyNudge()) { lastNudgeStage = "insert-reverted"; return false; }

    // ChatGPT can keep Send disabled while the composer is empty and enable or
    // replace it only after the input event. Insert the nudge first, then wait.
    const submitReady = await waitForCondition(() => {
      if (!composerContainsOnlyNudge()) return false;
      const candidate = document.querySelector(SUBMIT_SELECTOR);
      return !!candidate && !candidate.disabled && candidate.getAttribute("aria-disabled") !== "true";
    }, input.closest("form") || document.documentElement, Math.min(SEND_READY_TIMEOUT_MS, RECOVERY_RELOAD_TIMEOUT_MS));
    lastNudgeSubmitReady = submitReady;
    if (!submitReady || !composerContainsOnlyNudge()) { lastNudgeStage = "send-not-ready"; return false; }

    const submit = document.querySelector(SUBMIT_SELECTOR);
    if (!submit || submit.disabled || submit.getAttribute("aria-disabled") === "true") { lastNudgeStage = "send-button-invalid"; return false; }
    // Re-arm only the same-turn Stop handoff immediately before the synthetic
    // Send. Current Pro evidence still wins inside the guard.
    lastNudgeGuardArmed = armRecoveryNudge(originalKey).autoRecoveryAllowed === true;
    if (!lastNudgeGuardArmed) { lastNudgeStage = "guard-not-armed"; return false; }
    // At this point Stop has settled and is absent. A newly appearing Stop
    // button therefore belongs to the resumed request. Alternatively accept a
    // different streaming turn key. Do not accept the old turn's stale marker.
    setRecoveryPhase("confirming");
    const blockedBefore = recoveryGuardBlockedClicks();
    submit.click();

    // The Pro/unknown click guard can synchronously cancel our synthetic Send.
    // Detect that directly. A successful click may temporarily leave no live
    // streaming marker, so an immediate "unknown" model state is not failure.
    const blockedAfter = recoveryGuardBlockedClicks();
    lastNudgeClickBlocked = blockedBefore !== null && blockedAfter !== null && blockedAfter > blockedBefore;
    if (lastNudgeClickBlocked) { lastNudgeStage = "guard-blocked-click"; return false; }
    if (recoveryModelState().decision === "pro") { lastNudgeStage = "pro-after-click"; return false; }

    lastNudgeStage = "confirming-send";
    const confirmed = await waitForCondition(
      () => !!stopButton() || (() => {
        const live = findActiveTurn();
        const liveKey = turnKey(live);
        return !!liveKey && liveKey !== originalKey;
      })(),
      document.documentElement,
      SEND_CONFIRM_TIMEOUT_MS
    );
    lastNudgeConfirmed = confirmed;
    lastNudgeStage = confirmed ? "confirmed" : "send-not-confirmed";
    return confirmed;
  }


  function recoveryApprovalSnapshot(state, key) {
    return {
      turnKey: key || state?.turnKey || null,
      modelSlug: state?.modelSlug || null,
      selectedModelLabel: state?.selectedModelLabel || null,
      selectedModelLane: state?.selectedModelLane || null,
      decision: "non-pro",
      detectionSource: state?.detectionSource || null
    };
  }

  function currentRecoveryMarker() {
    if (!RELOAD_STATE || typeof RELOAD_STATE.read !== "function") return null;
    try { return RELOAD_STATE.read(conversationId()); } catch { return null; }
  }

  function clearRecoveryMarker() {
    if (!RELOAD_STATE || typeof RELOAD_STATE.clear !== "function") return false;
    try { return RELOAD_STATE.clear(); } catch { return false; }
  }

  function scheduleRecoveryReload(id, key, modelState, reason) {
    if (!RELOAD_STATE || typeof RELOAD_STATE.save !== "function") {
      lastRecoveryFailure = "reload-state-unavailable";
      return false;
    }
    const existing = currentRecoveryMarker();
    const reloadCount = existing && existing.conversationId === id ? Number(existing.reloadCount || 0) : 0;
    if (reloadCount >= MAX_RECOVERY_RELOADS) {
      lastRecoveryFailure = "reload-limit-reached";
      return false;
    }
    const marker = {
      conversationId: id,
      turnKey: key || null,
      reloadCount: reloadCount + 1,
      reason,
      createdAt: Date.now(),
      approval: recoveryApprovalSnapshot(modelState, key)
    };
    if (!RELOAD_STATE.save(marker)) {
      lastRecoveryFailure = "reload-state-write-failed";
      return false;
    }
    recoveryReloadCount = marker.reloadCount;
    lastRecoveryReloadReason = reason;
    recoveryReloadScheduled = true;
    lastRecoveryResult = "reloading";
    setRecoveryPhase("reloading");
    if (typeof RELOAD_STATE.reload !== "function" || RELOAD_STATE.reload() !== true) {
      recoveryReloadScheduled = false;
      lastRecoveryFailure = "reload-call-failed";
      return false;
    }
    return true;
  }

  function restoreReloadHandoff(marker) {
    const guard = globalThis.CGAntiCurseProRecoveryGuard;
    if (!guard || typeof guard.restoreRecoveryHandoff !== "function") return { autoRecoveryAllowed: false, decision: "unknown" };
    try {
      const state = guard.restoreRecoveryHandoff(marker?.approval || null);
      return state && typeof state === "object" ? state : { autoRecoveryAllowed: false, decision: "unknown" };
    } catch {
      return { autoRecoveryAllowed: false, decision: "unknown" };
    }
  }

  async function classifyReloadRunState(id) {
    // After reload, a stale streaming marker alone is not proof that the request
    // is still running. Prefer Stop, then backend state, then the composer having
    // returned to its ordinary non-Stop submit control.
    if (stopButton()) return { running: true, source: "stop-button", backendStatus: null };

    const backendStatus = await streamStatus(id);
    if (backendStatus === "IS_STREAMING") {
      const stopAppeared = await waitForCondition(() => !!stopButton(), document.documentElement, 10_000);
      return { running: true, source: stopAppeared ? "backend+stop" : "backend-no-stop", backendStatus };
    }
    if (backendStatus !== null) return { running: false, source: "backend", backendStatus };

    const submit = document.querySelector(SUBMIT_SELECTOR);
    if (submit) return { running: false, source: "composer-send", backendStatus: null };
    if (!findActiveTurn()) return { running: false, source: "no-live-turn", backendStatus: null };
    return { running: null, source: "unknown", backendStatus: null };
  }

  async function resumeRecoveryAfterReload() {
    const marker = currentRecoveryMarker();
    if (!marker) return false;
    recoveryReloadCount = Number(marker.reloadCount || 0);
    lastRecoveryReloadReason = marker.reason || null;
    if (!settings.stallRecoveryEnabled || marker.conversationId !== conversationId()) {
      clearRecoveryMarker();
      return false;
    }

    recoveryStartedAt = Number(marker.createdAt || 0) || Date.now();
    lastRecoveryResult = "in-flight";
    lastRecoveryFailure = null;
    setRecoveryPhase("reloading");
    const pageReady = await waitForCondition(
      () => !!composer() && document.readyState !== "loading",
      document.documentElement,
      RECOVERY_RELOAD_READY_TIMEOUT_MS
    );
    if (!pageReady) {
      lastRecoveryFailure = "reload-page-not-ready";
      lastRecoveryResult = "failed";
      lastRecoveryFinishedAt = Date.now();
      clearRecoveryMarker();
      setRecoveryPhase(null);
      return false;
    }
    if (!settings.stallRecoveryEnabled || marker.conversationId !== conversationId()) {
      lastRecoveryFailure = "reload-transaction-invalidated";
      lastRecoveryResult = "failed";
      lastRecoveryFinishedAt = Date.now();
      clearRecoveryMarker();
      setRecoveryPhase(null);
      return false;
    }
    if (hasUserDraft()) {
      lastRecoveryFailure = "user-draft-after-reload";
      lastRecoveryResult = "failed";
      lastRecoveryFinishedAt = Date.now();
      clearRecoveryMarker();
      setRecoveryPhase(null);
      return false;
    }

    // Decide from real run state after reload. The old DOM streaming marker may
    // survive cancellation, so it is never sufficient by itself.
    const runState = await classifyReloadRunState(marker.conversationId);
    let key = marker.turnKey || null;
    const live = findActiveTurn();
    if (runState.running === true) {
      const state = recoveryModelState();
      if (state.autoRecoveryAllowed !== true) {
        lastRecoveryFailure = state.decision === "pro" ? "pro-after-reload" : "reload-running-model-unknown";
        lastRecoveryResult = "failed";
        lastRecoveryFinishedAt = Date.now();
        clearRecoveryMarker();
        setRecoveryPhase(null);
        return false;
      }
      const stop = stopButton();
      if (!stop) {
        lastRecoveryFailure = "reload-running-no-stop";
        lastRecoveryResult = "failed";
        lastRecoveryFinishedAt = Date.now();
        clearRecoveryMarker();
        setRecoveryPhase(null);
        return false;
      }
      key = turnKey(live) || state.turnKey || key;
      attemptedTurnKey = key;
      setRecoveryPhase("stopping");
      stop.click();
      if (!(await waitForStopSettlement(marker.conversationId, key))) {
        lastRecoveryFailure = "reload-stop-not-settled";
        lastRecoveryResult = "failed";
        lastRecoveryFinishedAt = Date.now();
        clearRecoveryMarker();
        setRecoveryPhase(null);
        return false;
      }
      if (hasUserDraft()) {
        lastRecoveryFailure = "user-draft-after-reload-stop";
        lastRecoveryResult = "failed";
        lastRecoveryFinishedAt = Date.now();
        clearRecoveryMarker();
        setRecoveryPhase(null);
        return false;
      }
      if (recoveryNudgeModelState(key).autoRecoveryAllowed !== true) {
        lastRecoveryFailure = "model-blocked-after-reload-stop";
        lastRecoveryResult = "failed";
        lastRecoveryFinishedAt = Date.now();
        clearRecoveryMarker();
        setRecoveryPhase(null);
        return false;
      }
    } else if (runState.running === false) {
      const restored = restoreReloadHandoff(marker);
      if (restored.autoRecoveryAllowed !== true) {
        lastRecoveryFailure = restored.decision === "pro" ? "pro-after-reload" : "reload-handoff-rejected";
        lastRecoveryResult = "failed";
        lastRecoveryFinishedAt = Date.now();
        clearRecoveryMarker();
        setRecoveryPhase(null);
        return false;
      }
    } else {
      lastRecoveryFailure = "reload-run-state-unknown";
      lastRecoveryResult = "failed";
      lastRecoveryFinishedAt = Date.now();
      clearRecoveryMarker();
      setRecoveryPhase(null);
      return false;
    }

    setRecoveryPhase("sending");
    const sent = await sendNudge(key);
    if (!sent) {
      lastRecoveryFailure = `reload-${lastNudgeStage || "nudge-send-failed"}`;
      clearSyntheticNudge();
      lastRecoveryResult = "failed";
      lastRecoveryFinishedAt = Date.now();
      clearRecoveryMarker();
      setRecoveryPhase(null);
      return false;
    }

    lastRecoveryResult = "completed";
    lastRecoveryFinishedAt = Date.now();
    clearRecoveryMarker();
    setRecoveryPhase(null);
    syncActiveTurn();
    return true;
  }
  async function recoverStall(id, key, generation) {
    const identity = `${id || ""}\u001f${key || ""}`;
    if (generation !== recoveryGeneration || key !== activeTurnKey || attemptedTurns.has(identity) || recoveringTurns.has(identity)) return;
    if (hasUserDraft()) { scheduleStallCheck(30_000); return; }
    const stop = stopButton();
    if (!stop) return;
    const approvedModelState = recoveryModelState();
    recoveringTurns.add(identity);
    attemptedTurnKey = key;
    recoveryStartedAt = Date.now();
    lastRecoveryResult = "in-flight";
    lastRecoveryFailure = null;
    setRecoveryPhase("stopping");
    try {
      stop.click();
      if (!(await waitForStopSettlement(id, key))) {
        lastRecoveryFailure = "stop-not-settled";
        if (scheduleRecoveryReload(id, key, approvedModelState, "stop-still-loading")) return;
        return;
      }
      if (!settings.stallRecoveryEnabled || conversationId() !== id || generation !== recoveryGeneration) {
        lastRecoveryFailure = "transaction-invalidated";
        return;
      }
      if (hasUserDraft()) { lastRecoveryFailure = "user-draft-during-stop"; return; }
      if (recoveryNudgeModelState(key).autoRecoveryAllowed !== true) { lastRecoveryFailure = "model-blocked-after-stop"; return; }
      setRecoveryPhase("sending");
      if (!(await sendNudge(key))) {
        lastRecoveryFailure = lastNudgeStage || "nudge-send-failed";
        if ((lastNudgeStage === "send-not-ready" || lastNudgeStage === "send-not-confirmed" || lastNudgeStage === "insert-reverted") &&
            scheduleRecoveryReload(id, key, approvedModelState, `resume-${lastNudgeStage}`)) return;
        return;
      }
      attemptedTurns.add(identity);
      lastRecoveryResult = "completed";
      if (attemptedTurns.size > 256) attemptedTurns.delete(attemptedTurns.values().next().value);
    } finally {
      if (!recoveryReloadScheduled && lastRecoveryResult !== "completed") lastRecoveryResult = "failed";
      if (!recoveryReloadScheduled) lastRecoveryFinishedAt = Date.now();
      // Remove only AntiCurse's exact synthetic nudge after a failed Send. Never
      // touch a composer that the user changed while recovery was in flight.
      if (!recoveryReloadScheduled && lastRecoveryResult !== "completed") clearSyntheticNudge();
      recoveringTurns.delete(identity);
      if (!recoveryReloadScheduled) {
        setRecoveryPhase(null);
        // Reconcile whatever ChatGPT mounted while recovery owned the old turn.
        syncActiveTurn();
      }
    }
  }

  async function checkForStall() {
    stallTimer = null;
    if (!settings.stallRecoveryEnabled || !activeTurn || !stopButton()) return;
    const modelState = recoveryModelState();
    if (modelState.autoRecoveryAllowed !== true) { publishRecoveryStatus(); return; }
    const loading = shellLoading() || preOutputLoading(activeTurn);
    if (loading) {
      if (!loadingStartedAt) loadingStartedAt = Date.now();
      const elapsed = Date.now() - loadingStartedAt;
      if (elapsed < RECOVERY_RELOAD_TIMEOUT_MS) { scheduleStallCheck(RECOVERY_RELOAD_TIMEOUT_MS - elapsed); return; }
      if (hasUserDraft()) { scheduleStallCheck(30_000); return; }
      const id = conversationId();
      const key = activeTurnKey;
      recoveryStartedAt = Date.now();
      lastRecoveryResult = "in-flight";
      lastRecoveryFailure = null;
      if (!scheduleRecoveryReload(id, key, modelState, "pre-output-loading-timeout")) {
        lastRecoveryResult = "failed";
        lastRecoveryFinishedAt = Date.now();
        setRecoveryPhase(null);
      }
      return;
    }
    loadingStartedAt = 0;

    // OR semantics: the explicit long-wait banner is independently sufficient;
    // without it, retain the conservative inactivity + backend-confirmation path.
    const longWaitBanner = hasLongWaitBanner(activeTurn);
    const threshold = thresholdMs();
    if (!longWaitBanner) {
      const elapsed = Date.now() - lastActivityAt;
      if (elapsed < threshold) { scheduleStallCheck(threshold - elapsed); return; }
    }
    if (hasUserDraft()) { scheduleStallCheck(30_000); return; }

    const id = conversationId();
    const key = activeTurnKey;
    const generation = recoveryGeneration;
    setRecoveryPhase("checking");
    if (!longWaitBanner && await streamStatus(id) !== "IS_STREAMING") { setRecoveryPhase(null); return; }
    if (generation !== recoveryGeneration || key !== activeTurnKey) { setRecoveryPhase(null); return; }

    if (!longWaitBanner) {
      if (generation !== recoveryGeneration || key !== activeTurnKey) { setRecoveryPhase(null); return; }
      if (Date.now() - lastActivityAt < threshold || hasUserDraft() || !stopButton()) { setRecoveryPhase(null); return; }
      // Confirm the backend a second time immediately before intervention. There
      // is deliberately no extra grace delay: the user-selected deadline is the
      // actual deadline, subject only to the two network checks themselves.
      if (await streamStatus(id) !== "IS_STREAMING") { setRecoveryPhase(null); return; }
      if (generation !== recoveryGeneration || key !== activeTurnKey) { setRecoveryPhase(null); return; }
    } else if (!hasLongWaitBanner(activeTurn) || hasUserDraft() || !stopButton()) {
      setRecoveryPhase(null);
      return;
    }

    // Re-evaluate model identity immediately before any synthetic action. This
    // closes the race where the user switches to Pro while a backend check awaits.
    if (recoveryModelState().autoRecoveryAllowed !== true) { setRecoveryPhase(null); return; }
    await recoverStall(id, key, generation);
  }

  function teardown() {
    recoveryGeneration++;
    clearTimer();
    clearCountdownUiTimer();
    clearDiscovery();
    disconnectShellObservers();
    if (activityObserver) activityObserver.disconnect();
    if (turnListObserver) turnListObserver.disconnect();
    activityObserver = null;
    turnListObserver = null;
    activeTurn = null;
    activeTurnKey = null;
    turnList = null;
    loadingStartedAt = 0;
    recoveryPhase = null;
    publishRecoveryStatus();
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
      else { scheduleDiscovery(); publishRecoveryStatus(); }
    });

    if (settings.stallRecoveryEnabled) {
      scheduleDiscovery();
      queueMicrotask(() => { resumeRecoveryAfterReload().catch(() => {
        lastRecoveryFailure = "reload-resume-exception";
        lastRecoveryResult = "failed";
        lastRecoveryFinishedAt = Date.now();
        clearRecoveryMarker();
        setRecoveryPhase(null);
      }); });
    }
  }

  globalThis.CGAntiCurseStallRecovery = {
    debug() {
      return {
        enabled: settings.stallRecoveryEnabled,
        conversationId: conversationId(),
        activeTurn: !!activeTurn,
        activeTurnKey,
        liveTurnKey: turnKey(findActiveTurn()),
        activeTurnConnected: !!activeTurn?.isConnected,
        turnListConnected: !!turnList?.isConnected,
        longWaitBanner: hasLongWaitBanner(),
        assistantOutputPresent: hasAssistantOutput(),
        preOutputLoading: preOutputLoading(),
        shellLoading: shellLoading(),
        recoveryModelState: (() => {
          const state = recoveryModelState();
          return {
            decision: state.decision || "unknown",
            detectionSource: state.detectionSource || null,
            autoRecoveryAllowed: state.autoRecoveryAllowed === true,
            turnKey: state.turnKey || null,
            modelSlug: state.modelSlug || null
          };
        })(),
        recoveryPhase,
        countdownRemainingMs: recoveryRemainingMs(),
        recoveryStartedAt,
        lastRecoveryFinishedAt,
        lastRecoveryResult,
        lastRecoveryFailure,
        lastActivityAt,
        loadingStartedAt,
        recoveryReloadCount,
        lastRecoveryReloadReason,
        pendingRecoveryReload: currentRecoveryMarker(),
        lastNudgeStage,
        lastNudgeInsertMethod,
        lastNudgeInsertAccepted,
        lastNudgeSubmitReady,
        lastNudgeGuardArmed,
        lastNudgeClickBlocked,
        lastNudgeConfirmed,
        lastStopSettlementSource,
        lastStopBackendStatus,
        attemptedTurnKey,
        attemptedTurnCount: attemptedTurns.size,
        recoveryInFlightCount: recoveringTurns.size,
        recoveryStopSettleTimeoutSeconds: Math.min(STOP_SETTLE_TIMEOUT_MS, RECOVERY_RELOAD_TIMEOUT_MS) / 1000,
        recoverySendReadyTimeoutSeconds: Math.min(SEND_READY_TIMEOUT_MS, RECOVERY_RELOAD_TIMEOUT_MS) / 1000,
        recoverySendConfirmTimeoutSeconds: SEND_CONFIRM_TIMEOUT_MS / 1000,
        recoveryReloadTimeoutSeconds: RECOVERY_RELOAD_TIMEOUT_MS / 1000,
        timeoutSeconds: STALL_TIMEOUT_MS / 1000,
        turnListObserver: !!turnListObserver,
        shellObserverCount: shellObservers.length,
        discoveryObserver: !!discoveryObserver
      };
    }
  };

  start();
})();
