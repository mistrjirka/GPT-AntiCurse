/* Transactional recovery for ChatGPT runs that stall or remain loading. */
(() => {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const SESSION_AUTH = globalThis.CGAntiCurseSessionAuth;
  const COMPOSER_INPUT = globalThis.CGAntiCurseComposerInput;
  const RELOAD_STATE = globalThis.CGAntiCurseRecoveryReloadState;
  const DEFAULTS = Object.freeze({ stallRecoveryEnabled: true });
  const STALL_TIMEOUT_MS = 120_000;
  const PHASE_TIMEOUT_MS = 120_000;
  const SEND_CONFIRM_TIMEOUT_MS = 30_000;
  const STATUS_EVENT = "__gpt_anticurse_stall_status__";
  const TURN_CONTAINER_SELECTOR = '[data-turn-id-container]';
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const STREAMING_SELECTOR = '[data-streaming-response-status]';
  const STOP_SELECTOR = '#composer-submit-button[data-testid="stop-button"]';
  const SUBMIT_SELECTOR = '#composer-submit-button:not([data-testid="stop-button"])';
  const COMPOSER_SELECTOR = '#prompt-textarea[contenteditable="true"]';
  const SHELL_STREAM_SELECTOR = '[data-stream-active]';

  let settings = { ...DEFAULTS };
  let activeTurn = null;
  let activeTurnKey = null;
  let activeTurnStartedAt = 0;
  let lastProgressAt = 0;
  let lastOutputSignature = "";
  let shellLoadingStartedAt = 0;
  let activityObserver = null;
  let rootObserver = null;
  let syncQueued = false;
  let deadlineTimer = null;
  let countdownUiTimer = null;
  let monitorGeneration = 0;
  let transaction = null;
  const attemptedTurns = new Set();
  let attemptedTurnKey = null;
  let recoveryStartedAt = 0;
  let lastRecoveryFinishedAt = 0;
  let lastRecoveryResult = null;
  let lastRecoveryFailure = null;
  const transitionLog = [];

  function applySettings(next) {
    if (next && typeof next.stallRecoveryEnabled === "boolean") settings.stallRecoveryEnabled = next.stallRecoveryEnabled;
  }

  function conversationId() {
    const match = location.pathname.match(/^\/(?:c|branch)\/([^/?#]+)/);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch { return null; }
  }

  function stopButton() { return document.querySelector(STOP_SELECTOR); }
  function composer() { return (COMPOSER_INPUT && COMPOSER_INPUT.composer && COMPOSER_INPUT.composer()) || document.querySelector(COMPOSER_SELECTOR); }
  function draftText() { const node = composer(); return node ? String(node.textContent || "").trim() : ""; }

  function hasAttachmentDraft() {
    const input = composer();
    const form = input && input.closest("form");
    return !!(form && form.querySelector('[data-testid*="attachment"]:not(input), [data-testid*="upload-preview"]:not(input), [data-testid*="file-thumbnail"]:not(input), [data-testid*="file-pill"]:not(input)'));
  }

  function hasUserDraft() { return !!draftText() || hasAttachmentDraft(); }
  function composerContainsOnlyNudge() {
    if (COMPOSER_INPUT && typeof COMPOSER_INPUT.containsOnlyNudge === "function") return COMPOSER_INPUT.containsOnlyNudge() && !hasAttachmentDraft();
    return draftText() === "." && !hasAttachmentDraft();
  }

  function modelState() {
    const guard = globalThis.CGAntiCurseProRecoveryGuard;
    if (!guard || typeof guard.activeRecoveryState !== "function") return { decision: "unknown", autoRecoveryAllowed: false, detectionSource: "guard-unavailable" };
    try { return guard.activeRecoveryState() || { decision: "unknown", autoRecoveryAllowed: false, detectionSource: "guard-invalid" }; }
    catch { return { decision: "unknown", autoRecoveryAllowed: false, detectionSource: "guard-error" }; }
  }

  function nudgeModelState(turnKey) {
    const guard = globalThis.CGAntiCurseProRecoveryGuard;
    if (!guard || typeof guard.recoveryNudgeState !== "function") return modelState();
    try { return guard.recoveryNudgeState(turnKey) || modelState(); } catch { return modelState(); }
  }

  function armNudge(turnKey) {
    const guard = globalThis.CGAntiCurseProRecoveryGuard;
    if (!guard || typeof guard.armRecoveryNudge !== "function") return { decision: "unknown", autoRecoveryAllowed: false };
    try { return guard.armRecoveryNudge(turnKey) || { decision: "unknown", autoRecoveryAllowed: false }; }
    catch { return { decision: "unknown", autoRecoveryAllowed: false }; }
  }

  function blockedClickCount() {
    const guard = globalThis.CGAntiCurseProRecoveryGuard;
    if (!guard || typeof guard.debug !== "function") return null;
    try { const value = Number(guard.debug()?.blockedClicks); return Number.isFinite(value) ? value : null; }
    catch { return null; }
  }

  function turnKey(turn) {
    if (!turn) return null;
    const section = turn.matches?.(TURN_SELECTOR) ? turn : turn.querySelector?.(TURN_SELECTOR);
    return (section && (section.getAttribute("data-turn-id") || section.getAttribute("data-testid"))) || turn.getAttribute?.("data-turn-id-container") || null;
  }

  function newestAssistantTurn() {
    const turns = document.querySelectorAll(TURN_CONTAINER_SELECTOR);
    for (let index = turns.length - 1; index >= 0; index--) {
      const turn = turns[index];
      if (turn.querySelector('[data-message-author-role="assistant"], [data-turn="assistant"]')) return turn;
    }
    return null;
  }

  function findActiveTurn() {
    const newest = newestAssistantTurn();
    return newest && newest.querySelector(STREAMING_SELECTOR) ? newest : null;
  }

  function newestAssistantStreaming() {
    const turn = newestAssistantTurn();
    return !!(turn && turn.querySelector(STREAMING_SELECTOR));
  }

  function shellRunLoading() {
    const input = composer();
    const form = (input && input.closest('form[data-type="unified-composer"]')) || document.querySelector('form[data-type="unified-composer"]');
    const inert = !!(form && (form.hasAttribute("inert") || form.inert === true));
    return inert && !!document.querySelector(SHELL_STREAM_SELECTOR);
  }

  function composerIdle() {
    const input = composer();
    if (!input || !input.isConnected) return false;
    const form = input.closest("form");
    if (form && (form.hasAttribute("inert") || form.inert === true)) return false;
    return !stopButton();
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

  function outputSignature(turn = activeTurn) {
    if (!turn) return "";
    const parts = [];
    for (const node of turn.querySelectorAll('[data-message-author-role="assistant"] .markdown, [data-turn="assistant"] .markdown, [data-message-author-role="assistant"] pre, [data-turn="assistant"] pre')) {
      const text = String(node.textContent || "").trim();
      if (text) parts.push(text);
    }
    return parts.join("\n\u241e\n");
  }

  function hasAssistantOutput(turn = activeTurn) { return !!outputSignature(turn); }
  function preOutputLoading(turn = activeTurn) { return !!turn && !!turn.querySelector(STREAMING_SELECTOR) && !hasLongWaitBanner(turn) && !hasAssistantOutput(turn); }

  function recordTransition(phase, detail = null) {
    transitionLog.push({ at: Date.now(), phase, detail: detail || null });
    if (transitionLog.length > 24) transitionLog.shift();
  }

  function clearDeadlineTimer() { if (deadlineTimer !== null) clearTimeout(deadlineTimer); deadlineTimer = null; }
  function clearCountdownTimer() { if (countdownUiTimer !== null) clearTimeout(countdownUiTimer); countdownUiTimer = null; }

  function currentLoadingStartedAt() {
    if (preOutputLoading(activeTurn)) return activeTurnStartedAt || lastProgressAt || Date.now();
    if (shellRunLoading()) return shellLoadingStartedAt || Date.now();
    return 0;
  }

  function remainingMs() {
    if (transaction) return null;
    const state = modelState();
    if (state.autoRecoveryAllowed !== true) return null;
    if (hasLongWaitBanner(activeTurn)) return 0;
    const loadingAt = currentLoadingStartedAt();
    if (loadingAt) return Math.max(0, STALL_TIMEOUT_MS - (Date.now() - loadingAt));
    if (!activeTurn || !stopButton()) return null;
    return Math.max(0, STALL_TIMEOUT_MS - (Date.now() - (lastProgressAt || activeTurnStartedAt || Date.now())));
  }

  function publishStatus() {
    clearCountdownTimer();
    const state = modelState();
    const running = !!activeTurn || !!stopButton() || shellRunLoading();
    const active = settings.stallRecoveryEnabled && (!!transaction || running);
    if (!active) {
      window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: { active: false, conversationId: conversationId() } }));
      return;
    }
    const loading = shellRunLoading() || preOutputLoading(activeTurn);
    const phase = transaction?.phase ||
      (state.autoRecoveryAllowed !== true ? (state.decision === "pro" ? "blocked-pro" : "blocked-unknown") :
       hasUserDraft() ? "paused-draft" :
       hasLongWaitBanner(activeTurn) ? "checking" :
       loading ? "loading" : "countdown");
    window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: {
      active: true,
      conversationId: conversationId(),
      phase,
      remainingMs: remainingMs(),
      longWaitBanner: hasLongWaitBanner(activeTurn),
      draftBlocked: hasUserDraft(),
      recoveryDecision: state.decision || "unknown",
      recoveryDetectionSource: state.detectionSource || null
    } }));
    if (!transaction && state.autoRecoveryAllowed === true && !hasUserDraft()) countdownUiTimer = setTimeout(publishStatus, 1000);
  }

  function setPhase(phase, detail = null) {
    if (!transaction) transaction = { phase: phase || null };
    else transaction.phase = phase || null;
    recordTransition(phase || "idle", detail);
    publishStatus();
  }

  function clearTransaction() {
    transaction = null;
    publishStatus();
  }

  function scheduleSync() {
    if (syncQueued) return;
    syncQueued = true;
    queueMicrotask(() => { syncQueued = false; syncMonitoring(); });
  }

  function observeTurn(turn) {
    if (activityObserver) activityObserver.disconnect();
    activityObserver = null;
    activeTurn = turn || null;
    activeTurnKey = turnKey(activeTurn);
    monitorGeneration++;
    activeTurnStartedAt = activeTurn ? Date.now() : 0;
    lastProgressAt = activeTurnStartedAt;
    lastOutputSignature = outputSignature(activeTurn);
    if (!activeTurn) return;
    activityObserver = new MutationObserver(() => {
      if (transaction) return;
      if (hasLongWaitBanner(activeTurn)) { scheduleDeadline(0); return; }
      const signature = outputSignature(activeTurn);
      if (signature && signature !== lastOutputSignature) {
        lastOutputSignature = signature;
        lastProgressAt = Date.now();
        scheduleDeadline();
      } else publishStatus();
    });
    activityObserver.observe(activeTurn, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-streaming-response-status"] });
  }

  function syncMonitoring() {
    if (!settings.stallRecoveryEnabled) return;
    const shell = shellRunLoading();
    if (shell && !shellLoadingStartedAt) shellLoadingStartedAt = Date.now();
    if (!shell) shellLoadingStartedAt = 0;
    if (!transaction) {
      const live = findActiveTurn();
      if (live !== activeTurn) observeTurn(live);
    }
    scheduleDeadline();
    publishStatus();
  }

  function scheduleDeadline(delayOverride = null) {
    clearDeadlineTimer();
    if (!settings.stallRecoveryEnabled || transaction) return;
    const state = modelState();
    if (state.autoRecoveryAllowed !== true || hasUserDraft()) return;
    const loadingAt = currentLoadingStartedAt();
    if (!loadingAt && (!activeTurn || !stopButton())) return;
    const delay = delayOverride !== null ? Math.max(0, delayOverride) :
      hasLongWaitBanner(activeTurn) ? 0 :
      loadingAt ? Math.max(0, STALL_TIMEOUT_MS - (Date.now() - loadingAt)) :
      Math.max(0, STALL_TIMEOUT_MS - (Date.now() - (lastProgressAt || activeTurnStartedAt || Date.now())));
    deadlineTimer = setTimeout(checkDeadline, delay);
  }

  async function streamStatus(id) {
    if (!id || !SESSION_AUTH || typeof SESSION_AUTH.resolveAccessToken !== "function") return null;
    const auth = await SESSION_AUTH.resolveAccessToken({ isCurrent: () => conversationId() === id });
    if (!auth.ok || conversationId() !== id) return null;
    try {
      const response = await fetch(`${location.origin}/backend-api/conversation/${encodeURIComponent(id)}/stream_status`, {
        method: "GET", credentials: "same-origin", cache: "no-store",
        headers: { accept: "application/json", authorization: `Bearer ${auth.accessToken}` }
      });
      if (!response.ok) return null;
      const data = await response.json();
      return typeof data?.status === "string" ? data.status : null;
    } catch { return null; }
  }

  function waitForCondition(test, root, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      let observer = null;
      let timeout = null;
      const finish = (value) => {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        if (timeout !== null) clearTimeout(timeout);
        resolve(value);
      };
      try { if (test()) return finish(true); } catch { /* keep waiting */ }
      observer = new MutationObserver(() => { try { if (test()) finish(true); } catch { /* keep waiting */ } });
      observer.observe(root || document.documentElement, { childList: true, subtree: true, attributes: true });
      timeout = setTimeout(() => finish(false), timeoutMs);
    });
  }

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function domStopSettled() { return !stopButton() && !newestAssistantStreaming() && composerIdle(); }

  async function waitForStopSettlement(id) {
    const deadline = Date.now() + PHASE_TIMEOUT_MS;
    let nextBackendCheckAt = 0;
    while (Date.now() < deadline) {
      if (domStopSettled() && Date.now() >= nextBackendCheckAt) {
        const status = await streamStatus(id);
        if (status !== null && status !== "IS_STREAMING") return true;
        nextBackendCheckAt = Date.now() + 10_000;
      }
      await sleep(Math.min(1000, Math.max(100, deadline - Date.now())));
    }
    return false;
  }

  async function guardedReload(reason, key, state = modelState()) {
    if (!RELOAD_STATE || typeof RELOAD_STATE.armReload !== "function") {
      lastRecoveryFailure = "reload-state-unavailable";
      return false;
    }
    if (state.autoRecoveryAllowed !== true) {
      lastRecoveryFailure = state.decision === "pro" ? "reload-blocked-pro" : "reload-blocked-unknown";
      return false;
    }
    const armed = RELOAD_STATE.armReload({ conversationId: conversationId(), turnKey: key || activeTurnKey, reason, modelSlug: state.modelSlug || null });
    if (!armed || armed.ok !== true) {
      lastRecoveryFailure = armed?.reason || "reload-arm-failed";
      return false;
    }
    if (!transaction) transaction = {};
    transaction.phase = "reloading";
    transaction.reason = reason;
    recordTransition("reloading", reason);
    publishStatus();
    location.reload();
    return true;
  }

  function clearNudge() {
    if (COMPOSER_INPUT && typeof COMPOSER_INPUT.clearNudge === "function") return COMPOSER_INPUT.clearNudge();
    return false;
  }

  async function sendNudge(originalKey) {
    if (!COMPOSER_INPUT || typeof COMPOSER_INPUT.insertNudge !== "function") return { ok: false, failure: "composer-input-unavailable", submitted: false };
    if (hasUserDraft()) return { ok: false, failure: "user-draft-before-nudge", submitted: false };
    const input = composer();
    if (!COMPOSER_INPUT.insertNudge(input)) return { ok: false, failure: "nudge-insert-failed", submitted: false };
    await new Promise((resolve) => queueMicrotask(resolve));
    if (!composerContainsOnlyNudge()) return { ok: false, failure: "nudge-not-retained", submitted: false };

    setPhase("sending");
    const readyOrChanged = await waitForCondition(() => {
      if (!composerContainsOnlyNudge()) return true;
      const button = document.querySelector(SUBMIT_SELECTOR);
      return !!button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
    }, input?.closest("form") || document.documentElement, PHASE_TIMEOUT_MS);
    if (!composerContainsOnlyNudge()) return { ok: false, failure: "user-draft-during-send", submitted: false };
    if (!readyOrChanged) return { ok: false, failure: "send-not-ready", submitted: false };

    const safety = armNudge(originalKey);
    if (safety.autoRecoveryAllowed !== true) return { ok: false, failure: safety.decision === "pro" ? "send-blocked-pro" : "send-blocked-unknown", submitted: false };
    const submit = document.querySelector(SUBMIT_SELECTOR);
    if (!submit || submit.disabled || submit.getAttribute("aria-disabled") === "true") return { ok: false, failure: "send-button-lost", submitted: false };

    setPhase("confirming");
    const blockedBefore = blockedClickCount();
    submit.click();
    const blockedAfter = blockedClickCount();
    if (blockedBefore !== null && blockedAfter !== null && blockedAfter > blockedBefore) return { ok: false, failure: "send-guard-blocked", submitted: false };
    if (modelState().decision === "pro") return { ok: false, failure: "send-became-pro", submitted: true };

    const confirmed = await waitForCondition(() => {
      if (stopButton()) return true;
      const live = findActiveTurn();
      const key = turnKey(live);
      return !!key && key !== originalKey;
    }, document.documentElement, SEND_CONFIRM_TIMEOUT_MS);
    return confirmed ? { ok: true, failure: null, submitted: true } : { ok: false, failure: "new-run-not-confirmed", submitted: true };
  }

  function identity(id, key) { return `${id || ""}\u001f${key || ""}`; }

  function rememberAttempt(id, key) {
    if (!key) return;
    attemptedTurnKey = key;
    attemptedTurns.add(identity(id, key));
    if (attemptedTurns.size > 256) attemptedTurns.delete(attemptedTurns.values().next().value);
  }

  function finishReloadMarker(ok) {
    if (!RELOAD_STATE) return;
    const outcome = ok ? "completed" : "failed";
    if (typeof RELOAD_STATE.finish === "function") RELOAD_STATE.finish(outcome, { failure: ok ? null : lastRecoveryFailure });
    else if (typeof RELOAD_STATE.clear === "function") RELOAD_STATE.clear();
  }

  async function performStopAndResume({ id, key, allowReload }) {
    const state = modelState();
    if (state.autoRecoveryAllowed !== true) {
      lastRecoveryFailure = state.decision === "pro" ? "model-pro-before-stop" : "model-unknown-before-stop";
      return false;
    }
    const stop = stopButton();
    if (!stop) {
      lastRecoveryFailure = "stop-button-missing";
      return false;
    }

    setPhase("stopping");
    stop.click();
    if (!(await waitForStopSettlement(id))) {
      lastRecoveryFailure = "stop-not-settled";
      if (allowReload) return guardedReload("stop-timeout", key, nudgeModelState(key));
      return false;
    }
    if (!settings.stallRecoveryEnabled || conversationId() !== id) {
      lastRecoveryFailure = "transaction-invalidated";
      return false;
    }
    if (hasUserDraft()) {
      lastRecoveryFailure = "user-draft-during-stop";
      return false;
    }
    const postStopState = nudgeModelState(key);
    if (postStopState.autoRecoveryAllowed !== true) {
      lastRecoveryFailure = postStopState.decision === "pro" ? "model-pro-after-stop" : "model-unknown-after-stop";
      return false;
    }

    const sent = await sendNudge(key);
    if (sent.ok) return true;
    lastRecoveryFailure = sent.failure;
    if (!sent.submitted && sent.failure === "send-not-ready" && allowReload) {
      clearNudge();
      return guardedReload("send-readiness-timeout", key, postStopState);
    }
    return false;
  }

  async function recoverCurrentStall(id, key, generation) {
    const attemptId = identity(id, key);
    if (transaction || attemptedTurns.has(attemptId) || generation !== monitorGeneration || key !== activeTurnKey) return;
    transaction = { phase: "checking", id, key };
    recoveryStartedAt = Date.now();
    lastRecoveryResult = "in-flight";
    lastRecoveryFailure = null;
    attemptedTurnKey = key;
    recordTransition("checking", "stall");
    publishStatus();
    let completed = false;
    try {
      completed = await performStopAndResume({ id, key, allowReload: true });
      if (transaction?.phase === "reloading") return;
      rememberAttempt(id, key);
      lastRecoveryResult = completed ? "completed" : "failed";
    } finally {
      if (transaction?.phase !== "reloading") {
        if (!completed && composerContainsOnlyNudge()) clearNudge();
        lastRecoveryFinishedAt = Date.now();
        clearTransaction();
        scheduleSync();
      }
    }
  }

  async function checkDeadline() {
    deadlineTimer = null;
    if (!settings.stallRecoveryEnabled || transaction) return;
    const state = modelState();
    if (state.autoRecoveryAllowed !== true) { publishStatus(); return; }
    if (hasUserDraft()) { scheduleDeadline(30_000); publishStatus(); return; }

    const loadingAt = currentLoadingStartedAt();
    if (loadingAt) {
      const elapsed = Date.now() - loadingAt;
      if (elapsed < STALL_TIMEOUT_MS) { scheduleDeadline(STALL_TIMEOUT_MS - elapsed); return; }
      transaction = { phase: "checking", id: conversationId(), key: activeTurnKey };
      recoveryStartedAt = Date.now();
      lastRecoveryResult = "in-flight";
      lastRecoveryFailure = null;
      recordTransition("checking", "loading-timeout");
      publishStatus();
      const reloading = await guardedReload("loading-timeout", activeTurnKey, state);
      if (!reloading) {
        lastRecoveryResult = "failed";
        lastRecoveryFinishedAt = Date.now();
        clearTransaction();
      }
      return;
    }

    if (!activeTurn || !stopButton()) { scheduleSync(); return; }
    const longWait = hasLongWaitBanner(activeTurn);
    if (!longWait) {
      const elapsed = Date.now() - (lastProgressAt || activeTurnStartedAt || Date.now());
      if (elapsed < STALL_TIMEOUT_MS) { scheduleDeadline(STALL_TIMEOUT_MS - elapsed); return; }
    }

    const id = conversationId();
    const key = activeTurnKey;
    const generation = monitorGeneration;
    if (!longWait) {
      if (await streamStatus(id) !== "IS_STREAMING") { scheduleSync(); return; }
      if (generation !== monitorGeneration || key !== activeTurnKey || hasUserDraft() || !stopButton()) return;
      if (await streamStatus(id) !== "IS_STREAMING") { scheduleSync(); return; }
      if (generation !== monitorGeneration || key !== activeTurnKey) return;
    } else if (!hasLongWaitBanner(activeTurn) || !stopButton()) return;
    if (modelState().autoRecoveryAllowed !== true) return;
    await recoverCurrentStall(id, key, generation);
  }

  async function restoreReloadTransaction() {
    if (!RELOAD_STATE || typeof RELOAD_STATE.read !== "function") return;
    const marker = RELOAD_STATE.read();
    if (!marker) return;
    transaction = { phase: "restoring", id: marker.conversationId, key: marker.turnKey, reloadUsed: true };
    recoveryStartedAt = marker.createdAt || Date.now();
    lastRecoveryResult = "in-flight";
    lastRecoveryFailure = null;
    attemptedTurnKey = marker.turnKey || null;
    recordTransition("restoring", marker.reason || null);
    publishStatus();

    const finishEarly = (failure) => {
      lastRecoveryFailure = failure;
      lastRecoveryResult = "failed";
      rememberAttempt(marker.conversationId, marker.turnKey);
      finishReloadMarker(false);
      lastRecoveryFinishedAt = Date.now();
      clearTransaction();
    };

    const ready = await waitForCondition(() => !!composer() && document.readyState !== "loading", document.documentElement, PHASE_TIMEOUT_MS);
    if (!ready || conversationId() !== marker.conversationId) {
      finishEarly("reload-page-not-ready");
      return;
    }
    if (!settings.stallRecoveryEnabled) {
      finishEarly("recovery-disabled-after-reload");
      return;
    }
    if (hasUserDraft()) {
      finishEarly("user-draft-after-reload");
      return;
    }

    const state = modelState();
    if (state.autoRecoveryAllowed !== true) {
      finishEarly(state.decision === "pro" ? "model-pro-after-reload" : "model-unknown-after-reload");
      return;
    }

    const status = await streamStatus(marker.conversationId);
    const live = findActiveTurn();
    const liveKey = turnKey(live);
    const liveMatchesMarker = !!live && (!marker.turnKey || liveKey === marker.turnKey);
    const running = status === "IS_STREAMING" ||
      (status === null && (shellRunLoading() || !!stopButton() || liveMatchesMarker));
    let ok = false;
    let finalKey = marker.turnKey || liveKey;
    if (running) {
      const key = liveKey || marker.turnKey;
      finalKey = key || finalKey;
      RELOAD_STATE.updateStage?.("stop-after-reload", { turnKey: key });
      ok = await performStopAndResume({ id: marker.conversationId, key, allowReload: false });
    } else {
      RELOAD_STATE.updateStage?.("send-after-reload");
      const sent = await sendNudge(marker.turnKey);
      ok = sent.ok;
      if (!ok) lastRecoveryFailure = sent.failure;
    }

    if (!ok && composerContainsOnlyNudge()) clearNudge();
    rememberAttempt(marker.conversationId, finalKey);
    finishReloadMarker(ok);
    lastRecoveryResult = ok ? "completed" : "failed";
    lastRecoveryFinishedAt = Date.now();
    clearTransaction();
    scheduleSync();
  }

  function teardown() {
    monitorGeneration++;
    clearDeadlineTimer();
    clearCountdownTimer();
    if (activityObserver) activityObserver.disconnect();
    if (rootObserver) rootObserver.disconnect();
    activityObserver = null;
    rootObserver = null;
    activeTurn = null;
    activeTurnKey = null;
    transaction = null;
    publishStatus();
  }

  function startObservers() {
    if (!document.documentElement) return;
    if (!rootObserver) {
      rootObserver = new MutationObserver(scheduleSync);
      rootObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["inert", "data-stream-active", "data-streaming-response-status"] });
    }
    scheduleSync();
  }

  async function start() {
    let stored = {};
    try { stored = await ext.storage.local.get(DEFAULTS); } catch { /* defaults */ }
    applySettings(stored);
    ext.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local" || !changes.stallRecoveryEnabled) return;
      applySettings({ stallRecoveryEnabled: changes.stallRecoveryEnabled.newValue });
      if (!settings.stallRecoveryEnabled) teardown();
      else startObservers();
    });
    if (!settings.stallRecoveryEnabled) return;
    startObservers();
    await restoreReloadTransaction();
  }

  globalThis.CGAntiCurseStallRecovery = {
    debug() {
      const state = modelState();
      return {
        enabled: settings.stallRecoveryEnabled,
        conversationId: conversationId(),
        activeTurn: !!activeTurn,
        activeTurnKey,
        liveTurnKey: turnKey(findActiveTurn()),
        newestAssistantStreaming: newestAssistantStreaming(),
        composerIdle: composerIdle(),
        shellLoading: shellRunLoading(),
        assistantOutputPresent: hasAssistantOutput(),
        preOutputLoading: preOutputLoading(),
        recoveryModelState: {
          decision: state.decision || "unknown",
          detectionSource: state.detectionSource || null,
          autoRecoveryAllowed: state.autoRecoveryAllowed === true,
          turnKey: state.turnKey || null,
          modelSlug: state.modelSlug || null
        },
        recoveryPhase: transaction?.phase || null,
        countdownRemainingMs: remainingMs(),
        recoveryStartedAt,
        lastRecoveryFinishedAt,
        lastRecoveryResult,
        lastRecoveryFailure,
        lastProgressAt,
        activeTurnStartedAt,
        shellLoadingStartedAt,
        attemptedTurnKey,
        attemptedTurnCount: attemptedTurns.size,
        timeoutSeconds: STALL_TIMEOUT_MS / 1000,
        phaseTimeoutSeconds: PHASE_TIMEOUT_MS / 1000,
        sendConfirmTimeoutSeconds: SEND_CONFIRM_TIMEOUT_MS / 1000,
        reloadMarker: RELOAD_STATE?.read?.() || null,
        composerInput: COMPOSER_INPUT?.debug?.() || { present: !!COMPOSER_INPUT },
        transitions: transitionLog.slice()
      };
    }
  };

  start();
})();
