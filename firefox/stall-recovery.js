/* Transactional recovery for ChatGPT runs that stall or remain loading. */
(() => {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const SESSION_AUTH = globalThis.CGAntiCurseSessionAuth;
  const COMPOSER_INPUT = globalThis.CGAntiCurseComposerInput;
  const RELOAD_STATE = globalThis.CGAntiCurseRecoveryReloadState;
  const RECOVERY_POLICY = globalThis.CGAntiCurseRecoveryPolicy;
  const DEFAULT_STALL_TIMEOUT_SECONDS = 120;
  const MIN_STALL_TIMEOUT_SECONDS = 10;
  const MAX_STALL_TIMEOUT_SECONDS = 3600;
  const DEFAULTS = Object.freeze({ stallRecoveryEnabled: true, stallRecoveryTimeoutSeconds: DEFAULT_STALL_TIMEOUT_SECONDS });
  const PHASE_TIMEOUT_MS = 120_000;
  const MODEL_HYDRATION_TIMEOUT_MS = 15_000;
  const UNKNOWN_MODEL_RECHECK_MS = 500;
  const STREAM_STATUS_TIMEOUT_MS = 5_000;
  const UI_SETTLE_GRACE_MS = 750;
  const EMPTY_COMPLETION_GRACE_MS = 750;
  const EMPTY_COMPLETION_RETRY_LIMIT = 3;
  const SEND_CONFIRM_TIMEOUT_MS = 30_000;
  const STATUS_EVENT = "__gpt_anticurse_stall_status__";
  const STATUS_BADGE_ID = "cg-conversation-guard-status";
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
  let terminalEmptyTimer = null;
  let monitorGeneration = 0;
  let transaction = null;
  const attemptedTurns = new Set();
  const settledTurns = new Set();
  const observedRunningTurns = new Set();
  let attemptedTurnKey = null;
  let recoveryStartedAt = 0;
  let lastRecoveryFinishedAt = 0;
  let lastRecoveryResult = null;
  let lastRecoveryFailure = null;
  let lastTriggerBackendStatus = null;
  let lastSettlementSource = null;
  let terminalEmptyCandidateKey = null;
  let terminalEmptySince = 0;
  let emptyCompletionRecoveryCount = 0;
  let lastObservedUserTurnKey = null;
  let monitoredConversationId = null;
  const transitionLog = [];

  function normalizeStallRecoveryTimeoutSeconds(value) {
    const number = Number(value);
    return Math.max(MIN_STALL_TIMEOUT_SECONDS, Math.min(MAX_STALL_TIMEOUT_SECONDS, Number.isFinite(number) ? Math.round(number) : DEFAULT_STALL_TIMEOUT_SECONDS));
  }

  function stallTimeoutMs() { return settings.stallRecoveryTimeoutSeconds * 1000; }

  function applySettings(next) {
    if (next && typeof next.stallRecoveryEnabled === "boolean") settings.stallRecoveryEnabled = next.stallRecoveryEnabled;
    if (next && Object.prototype.hasOwnProperty.call(next, "stallRecoveryTimeoutSeconds")) {
      settings.stallRecoveryTimeoutSeconds = normalizeStallRecoveryTimeoutSeconds(next.stallRecoveryTimeoutSeconds);
    }
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

  function rememberSettledTurn(key) {
    if (!key) return;
    settledTurns.add(key);
    if (settledTurns.size > 256) settledTurns.delete(settledTurns.values().next().value);
  }

  function newestAssistantTurn() {
    const turns = document.querySelectorAll(TURN_CONTAINER_SELECTOR);
    for (let index = turns.length - 1; index >= 0; index--) {
      const turn = turns[index];
      if (turn.querySelector('[data-message-author-role="assistant"], [data-turn="assistant"]')) return turn;
    }
    return null;
  }

  function newestRoleTurn() {
    const turns = document.querySelectorAll(TURN_CONTAINER_SELECTOR);
    for (let index = turns.length - 1; index >= 0; index--) {
      const turn = turns[index];
      if (turn.querySelector('[data-message-author-role="user"], [data-turn="user"]')) return { turn, role: "user" };
      if (turn.querySelector('[data-message-author-role="assistant"], [data-turn="assistant"]')) return { turn, role: "assistant" };
    }
    return { turn: null, role: null };
  }

  function userTurnText(turn) {
    if (!turn) return "";
    const node = turn.querySelector('[data-message-author-role="user"], [data-turn="user"]');
    return String(node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function findActiveTurn() {
    const newest = newestAssistantTurn();
    if (!newest || !newest.querySelector(STREAMING_SELECTOR)) return null;
    const key = turnKey(newest);
    if (settledTurns.has(key) || attemptedTurns.has(identity(conversationId(), key))) return null;
    return newest;
  }

  function newestAssistantStreaming() {
    const turn = newestAssistantTurn();
    return !!(turn && turn.querySelector(STREAMING_SELECTOR));
  }

  function attemptedCurrentTurn(turn = newestAssistantTurn()) {
    const key = turnKey(turn);
    return !!key && attemptedTurns.has(identity(conversationId(), key));
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

  function hasFinalOutputRegion(turn) {
    if (!turn) return false;
    const regions = turn.querySelectorAll('[data-conversation-screenshot-content]');
    const region = regions.length > 1 ? regions[regions.length - 1] : null;
    if (!region) return false;
    if (String(region.textContent || "").trim()) return true;
    return !!region.querySelector('[data-writing-block], img[src], video, audio, canvas, iframe, a[href], button:not([aria-label="Open tool call list"])');
  }

  function hasSubstantiveFinalOutput(turn) {
    if (!turn) return false;
    if (hasAssistantOutput(turn) || hasFinalOutputRegion(turn)) return true;
    return !!turn.querySelector('[data-writing-block], img[src], video, audio, canvas, iframe, a[download], a[href*="/backend-api/files/"]');
  }

  function hasIncompleteTerminalEvidence(turn) {
    if (!turn) return false;
    if (turn.querySelector('[aria-label="Open tool call list"], [data-testid="cot-v5-tool-icon-pile"], [data-testid="cot-v5-native-tool-icon"], [class*="group/tool-message"]')) return true;
    for (const button of turn.querySelectorAll('button')) {
      if (String(button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === "stopped thinking") return true;
    }
    return false;
  }

  function preOutputLoading(turn = activeTurn) { return !!turn && !!turn.querySelector(STREAMING_SELECTOR) && !hasLongWaitBanner(turn) && !hasAssistantOutput(turn); }

  function recordTransition(phase, detail = null) {
    transitionLog.push({ at: Date.now(), phase, detail: detail || null });
    if (transitionLog.length > 24) transitionLog.shift();
  }

  function clearDeadlineTimer() { if (deadlineTimer !== null) clearTimeout(deadlineTimer); deadlineTimer = null; }
  function clearCountdownTimer() { if (countdownUiTimer !== null) clearTimeout(countdownUiTimer); countdownUiTimer = null; }
  function clearTerminalEmptyTimer() { if (terminalEmptyTimer !== null) clearTimeout(terminalEmptyTimer); terminalEmptyTimer = null; }

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
    if (loadingAt) return Math.max(0, stallTimeoutMs() - (Date.now() - loadingAt));
    if (!activeTurn || !stopButton()) return null;
    return Math.max(0, stallTimeoutMs() - (Date.now() - (lastProgressAt || activeTurnStartedAt || Date.now())));
  }

  function publishStatus() {
    clearCountdownTimer();
    const state = modelState();
    const shellLoading = shellRunLoading();
    const active = settings.stallRecoveryEnabled && (RECOVERY_POLICY?.recoveryVisible?.({
      transactionActive: !!transaction,
      liveTurnPresent: !!findActiveTurn(),
      shellLoading
    }) ?? (!!transaction || shellLoading || !!findActiveTurn()));
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
    if (!transaction && !hasUserDraft()) {
      if (state.autoRecoveryAllowed === true) countdownUiTimer = setTimeout(publishStatus, 1000);
      else if (state.decision === "unknown") countdownUiTimer = setTimeout(syncMonitoring, UNKNOWN_MODEL_RECHECK_MS);
    }
  }

  function setPhase(phase, detail = null) {
    if (!transaction) transaction = { phase: phase || null };
    else transaction.phase = phase || null;
    recordTransition(phase || "idle", detail);
    publishStatus();
  }

  function clearTransaction() {
    transaction = null;
    terminalEmptyCandidateKey = null;
    terminalEmptySince = 0;
    publishStatus();
  }

  function scheduleSync() {
    if (syncQueued) return;
    syncQueued = true;
    queueMicrotask(() => { syncQueued = false; syncMonitoring(); });
  }

  function nodeIsOwnStatusUi(node) {
    if (!(node instanceof Element)) return false;
    return node.id === STATUS_BADGE_ID || !!node.closest?.(`#${STATUS_BADGE_ID}`);
  }

  function mutationIsOnlyOwnStatusUi(record) {
    if (!record) return false;
    if (nodeIsOwnStatusUi(record.target)) return true;
    if (record.type !== "childList") return false;
    const changed = [...(record.addedNodes || []), ...(record.removedNodes || [])];
    return changed.length > 0 && changed.every(nodeIsOwnStatusUi);
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

  function rememberObservedRunningTurn(turn) {
    const key = turnKey(turn);
    const id = conversationId();
    if (!key || !id || !stopButton()) return;
    observedRunningTurns.add(identity(id, key));
    if (observedRunningTurns.size > 256) observedRunningTurns.delete(observedRunningTurns.values().next().value);
  }

  function resetTerminalEmptyCandidate() {
    clearTerminalEmptyTimer();
    terminalEmptyCandidateKey = null;
    terminalEmptySince = 0;
  }

  function maybeResetEmptyRecoveryChain() {
    const latest = newestRoleTurn();
    const key = turnKey(latest.turn);
    if (latest.role === "assistant" && hasSubstantiveFinalOutput(latest.turn)) {
      emptyCompletionRecoveryCount = 0;
      return;
    }
    if (latest.role === "user" && key && key !== lastObservedUserTurnKey) {
      lastObservedUserTurnKey = key;
      if (userTurnText(latest.turn) !== ".") emptyCompletionRecoveryCount = 0;
    }
  }

  async function recoverTerminalEmptyTurn(id, key) {
    if (transaction || !id || !key) return;
    const latest = newestRoleTurn();
    if (latest.role !== "assistant" || turnKey(latest.turn) !== key) return;
    const attemptId = identity(id, recoveryAttemptKey(key));
    const decision = RECOVERY_POLICY?.terminalEmpty?.({
      observedRunning: observedRunningTurns.has(identity(id, key)),
      latestRole: latest.role,
      stopPresent: !!stopButton(),
      composerIdle: composerIdle(),
      hasFinalOutput: hasSubstantiveFinalOutput(latest.turn),
      hasIncompleteEvidence: hasIncompleteTerminalEvidence(latest.turn),
      attempted: attemptedTurns.has(attemptId),
      stableMs: terminalEmptySince ? Date.now() - terminalEmptySince : 0,
      graceMs: EMPTY_COMPLETION_GRACE_MS,
      retryCount: emptyCompletionRecoveryCount,
      retryLimit: EMPTY_COMPLETION_RETRY_LIMIT
    });
    if (!decision?.ready || hasUserDraft()) return;
    await recoverTurn(id, key, null, "empty-completion", false);
  }

  function syncTerminalEmptyCandidate() {
    if (transaction || !settings.stallRecoveryEnabled) { resetTerminalEmptyCandidate(); return; }
    maybeResetEmptyRecoveryChain();
    const id = conversationId();
    const latest = newestRoleTurn();
    const key = turnKey(latest.turn);
    const attempted = !!key && attemptedTurns.has(identity(id, recoveryAttemptKey(key)));
    const decision = RECOVERY_POLICY?.terminalEmpty?.({
      observedRunning: !!key && observedRunningTurns.has(identity(id, key)),
      latestRole: latest.role,
      stopPresent: !!stopButton(),
      composerIdle: composerIdle(),
      hasFinalOutput: hasSubstantiveFinalOutput(latest.turn),
      hasIncompleteEvidence: hasIncompleteTerminalEvidence(latest.turn),
      attempted,
      stableMs: terminalEmptyCandidateKey === key && terminalEmptySince ? Date.now() - terminalEmptySince : 0,
      graceMs: EMPTY_COMPLETION_GRACE_MS,
      retryCount: emptyCompletionRecoveryCount,
      retryLimit: EMPTY_COMPLETION_RETRY_LIMIT
    });
    if (!decision?.candidate || !key || !id || hasUserDraft()) { resetTerminalEmptyCandidate(); return; }
    if (terminalEmptyCandidateKey !== key) {
      resetTerminalEmptyCandidate();
      terminalEmptyCandidateKey = key;
      terminalEmptySince = Date.now();
    }
    const elapsed = Date.now() - terminalEmptySince;
    if (elapsed >= EMPTY_COMPLETION_GRACE_MS) {
      clearTerminalEmptyTimer();
      queueMicrotask(() => recoverTerminalEmptyTurn(id, key));
      return;
    }
    clearTerminalEmptyTimer();
    terminalEmptyTimer = setTimeout(() => { terminalEmptyTimer = null; syncMonitoring(); }, EMPTY_COMPLETION_GRACE_MS - elapsed);
  }

  function syncMonitoring() {
    if (!settings.stallRecoveryEnabled) return;
    const currentConversationId = conversationId();
    if (currentConversationId !== monitoredConversationId) {
      monitoredConversationId = currentConversationId;
      emptyCompletionRecoveryCount = 0;
      lastObservedUserTurnKey = null;
      resetTerminalEmptyCandidate();
    }
    const shell = shellRunLoading();
    if (shell && !shellLoadingStartedAt) shellLoadingStartedAt = Date.now();
    if (!shell) shellLoadingStartedAt = 0;
    if (!transaction) {
      const newest = newestAssistantTurn();
      rememberObservedRunningTurn(newest);
      const live = findActiveTurn();
      if (live !== activeTurn) observeTurn(live);
      syncTerminalEmptyCandidate();
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
      loadingAt ? Math.max(0, stallTimeoutMs() - (Date.now() - loadingAt)) :
      Math.max(0, stallTimeoutMs() - (Date.now() - (lastProgressAt || activeTurnStartedAt || Date.now())));
    deadlineTimer = setTimeout(checkDeadline, delay);
  }

  async function streamStatus(id) {
    if (!id || !SESSION_AUTH || typeof SESSION_AUTH.resolveAccessToken !== "function") return null;
    const controller = new AbortController();
    let timeout = null;
    const request = (async () => {
      const auth = await SESSION_AUTH.resolveAccessToken({ isCurrent: () => conversationId() === id });
      if (!auth.ok || conversationId() !== id || controller.signal.aborted) return null;
      const response = await fetch(`${location.origin}/backend-api/conversation/${encodeURIComponent(id)}/stream_status`, {
        method: "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { accept: "application/json", authorization: `Bearer ${auth.accessToken}` }
      });
      if (!response.ok) return null;
      const data = await response.json();
      return typeof data?.status === "string" ? data.status : null;
    })();
    const timedOut = new Promise((resolve) => {
      timeout = setTimeout(() => { controller.abort(); resolve(null); }, STREAM_STATUS_TIMEOUT_MS);
    });
    try { return await Promise.race([request, timedOut]); }
    catch { return null; }
    finally { if (timeout !== null) clearTimeout(timeout); }
  }

  function waitForCondition(test, root, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      let observer = null;
      let timeout = null;
      let readyStateHandler = null;
      const finish = (value) => {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        if (timeout !== null) clearTimeout(timeout);
        if (readyStateHandler) document.removeEventListener("readystatechange", readyStateHandler);
        resolve(value);
      };
      const check = () => {
        try { if (test()) finish(true); } catch { /* keep waiting */ }
      };
      check();
      if (done) return;
      observer = new MutationObserver(check);
      observer.observe(root || document.documentElement || document, { childList: true, subtree: true, attributes: true, characterData: true });
      readyStateHandler = check;
      document.addEventListener("readystatechange", readyStateHandler);
      queueMicrotask(check);
      timeout = setTimeout(() => finish(false), timeoutMs);
    });
  }

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function stopUiSettled() { return !stopButton() && composerIdle(); }
  function domStopSettled() { return stopUiSettled() && !newestAssistantStreaming(); }
  function decisiveModelState(state) { return state?.decision === "pro" || state?.autoRecoveryAllowed === true; }

  async function recoverySafety(turnKey, waitForHydration = false) {
    let state = nudgeModelState(turnKey);
    if (decisiveModelState(state) || !waitForHydration) return state;
    await waitForCondition(() => decisiveModelState(nudgeModelState(turnKey)), document.documentElement, MODEL_HYDRATION_TIMEOUT_MS);
    return nudgeModelState(turnKey);
  }

  function rejectUnsafeModel(state, stage) {
    lastRecoveryFailure = state?.decision === "pro" ? `model-pro-${stage}` : `model-unknown-${stage}`;
    return false;
  }

  async function guardedReload(reason, key, state = nudgeModelState(key)) {
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
  function recoveryAttemptKey(key) { return key || "__shell-loading__"; }

  function rememberAttempt(id, key) {
    const attemptKey = recoveryAttemptKey(key);
    attemptedTurnKey = attemptKey;
    attemptedTurns.add(identity(id, attemptKey));
    if (attemptedTurns.size > 256) attemptedTurns.delete(attemptedTurns.values().next().value);
  }

  function finishReloadMarker(ok) {
    if (!RELOAD_STATE) return;
    const outcome = ok ? "completed" : "failed";
    if (typeof RELOAD_STATE.finish === "function") RELOAD_STATE.finish(outcome, { failure: ok ? null : lastRecoveryFailure });
    else if (typeof RELOAD_STATE.clear === "function") RELOAD_STATE.clear();
  }

  async function settleRunForContinuation({ id, key, allowReload, waitForModelHydration }) {
    const deadline = Date.now() + PHASE_TIMEOUT_MS;
    let stopRequested = false;
    let uiSettledSince = 0;
    lastSettlementSource = null;

    while (Date.now() < deadline) {
      if (!settings.stallRecoveryEnabled || conversationId() !== id) {
        lastRecoveryFailure = "transaction-invalidated";
        return false;
      }
      if (hasUserDraft()) {
        lastRecoveryFailure = stopRequested ? "user-draft-during-stop" : "user-draft-before-stop";
        return false;
      }

      const stop = stopButton();
      if (!stopRequested && stop) {
        const state = await recoverySafety(key, waitForModelHydration);
        if (state.autoRecoveryAllowed !== true) return rejectUnsafeModel(state, "before-stop");
        setPhase("stopping");
        stop.click();
        stopRequested = true;
        uiSettledSince = 0;
        await sleep(100);
        continue;
      }

      // The ChatGPT UI can be ready for another message while both its old
      // data-streaming-response-status marker and stream_status still lag. Once
      // Stop is gone and the composer is interactive, keep that state stable for
      // a short React handoff window and treat it as settled. This is exactly what
      // a human uses to decide the stopped run is over.
      const uiReady = stopUiSettled();
      if (uiReady) {
        if (!uiSettledSince) {
          uiSettledSince = Date.now();
          setPhase("settling");
        }
      } else {
        uiSettledSince = 0;
      }

      const decision = RECOVERY_POLICY?.settlement?.({
        stopPresent: !!stopButton(),
        composerIdle: composerIdle(),
        uiSettledMs: uiSettledSince ? Date.now() - uiSettledSince : 0,
        uiGraceMs: UI_SETTLE_GRACE_MS
      });
      if (decision?.settled) {
        rememberSettledTurn(key);
        lastSettlementSource = decision.source;
        recordTransition("settled", decision.source === "ui" ? "ui-idle" : decision.source);
        return true;
      }

      await sleep(Math.min(250, Math.max(100, deadline - Date.now())));
    }

    lastRecoveryFailure = stopRequested ? "stop-not-settled" : "run-not-settled";
    if (allowReload) {
      const state = await recoverySafety(key, false);
      return guardedReload(stopRequested ? "stop-timeout" : "run-state-timeout", key, state);
    }
    return false;
  }

  async function resumeSettledRun({ id, key, allowReload, waitForModelHydration }) {
    if (!settings.stallRecoveryEnabled || conversationId() !== id) {
      lastRecoveryFailure = "transaction-invalidated";
      return false;
    }
    if (hasUserDraft()) {
      lastRecoveryFailure = "user-draft-before-nudge";
      return false;
    }
    const state = await recoverySafety(key, waitForModelHydration);
    if (state.autoRecoveryAllowed !== true) return rejectUnsafeModel(state, "before-nudge");

    const sent = await sendNudge(key);
    if (sent.ok) return true;
    lastRecoveryFailure = sent.failure;
    if (!sent.submitted && sent.failure === "send-not-ready" && allowReload) {
      clearNudge();
      return guardedReload("send-readiness-timeout", key, state);
    }
    return false;
  }

  async function runRecoveryTransaction({ id, key, allowReload, waitForModelHydration = false }) {
    if (!(await settleRunForContinuation({ id, key, allowReload, waitForModelHydration }))) return false;
    if (transaction?.phase === "reloading") return false;
    return resumeSettledRun({ id, key, allowReload, waitForModelHydration });
  }

  async function recoverTurn(id, key, generation, reason = "stall-timeout", requireActiveMatch = true) {
    const attemptId = identity(id, recoveryAttemptKey(key));
    if (transaction || attemptedTurns.has(attemptId)) return;
    if (requireActiveMatch && (generation !== monitorGeneration || key !== activeTurnKey)) return;
    const initialPhase = reason === "empty-completion" ? "checking-empty" : "checking";
    transaction = { phase: initialPhase, id, key, reason };
    recoveryStartedAt = Date.now();
    lastRecoveryResult = "in-flight";
    lastRecoveryFailure = null;
    lastSettlementSource = null;
    attemptedTurnKey = key;
    recordTransition(initialPhase, reason);
    publishStatus();
    let completed = false;
    try {
      completed = await runRecoveryTransaction({
        id,
        key,
        allowReload: true,
        waitForModelHydration: reason === "empty-completion"
      });
      if (transaction?.phase === "reloading") return;
      rememberAttempt(id, key);
      if (completed && reason === "empty-completion") emptyCompletionRecoveryCount++;
      lastRecoveryResult = completed ? "completed" : "failed";
      recordTransition(lastRecoveryResult, completed ? lastSettlementSource : lastRecoveryFailure);
    } finally {
      if (transaction?.phase !== "reloading") {
        if (!completed && composerContainsOnlyNudge()) clearNudge();
        lastRecoveryFinishedAt = Date.now();
        clearTransaction();
        scheduleSync();
      }
    }
  }

  async function recoverCurrentStall(id, key, generation, reason = "stall-timeout") {
    return recoverTurn(id, key, generation, reason, true);
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
      if (elapsed < stallTimeoutMs()) { scheduleDeadline(stallTimeoutMs() - elapsed); return; }
      const id = conversationId();
      const key = activeTurnKey;
      const generation = monitorGeneration;
      const reason = preOutputLoading(activeTurn) ? "pre-output-timeout" : "shell-loading-timeout";
      lastTriggerBackendStatus = null;
      await recoverCurrentStall(id, key, generation, reason);
      return;
    }

    if (!activeTurn || !stopButton()) { scheduleSync(); return; }
    const longWait = hasLongWaitBanner(activeTurn);
    if (!longWait) {
      const elapsed = Date.now() - (lastProgressAt || activeTurnStartedAt || Date.now());
      if (elapsed < stallTimeoutMs()) { scheduleDeadline(stallTimeoutMs() - elapsed); return; }
    }

    const id = conversationId();
    const key = activeTurnKey;
    const generation = monitorGeneration;
    let triggerReason = longWait ? "long-wait-banner" : "stall-timeout";
    lastTriggerBackendStatus = null;
    if (!longWait) {
      const status = await streamStatus(id);
      lastTriggerBackendStatus = status;
      if (status !== null && status !== "IS_STREAMING") {
        rememberSettledTurn(key);
        recordTransition("settled", "backend-non-streaming");
        observeTurn(null);
        publishStatus();
        return;
      }
      if (status === null) triggerReason = "stall-timeout-status-unknown";
      if (generation !== monitorGeneration || key !== activeTurnKey || hasUserDraft() || !stopButton()) return;
    } else if (!hasLongWaitBanner(activeTurn) || !stopButton()) return;
    if (modelState().autoRecoveryAllowed !== true) return;
    await recoverCurrentStall(id, key, generation, triggerReason);
  }

  async function restoreReloadTransaction() {
    if (!RELOAD_STATE || typeof RELOAD_STATE.read !== "function") return;
    const marker = RELOAD_STATE.read();
    if (!marker) return;
    transaction = { phase: "restoring", id: marker.conversationId, key: marker.turnKey, reloadUsed: true };
    recoveryStartedAt = marker.createdAt || Date.now();
    lastRecoveryResult = "in-flight";
    lastRecoveryFailure = null;
    lastTriggerBackendStatus = null;
    lastSettlementSource = null;
    attemptedTurnKey = marker.turnKey || null;
    recordTransition("restoring", marker.reason || null);
    publishStatus();

    const finishEarly = (failure) => {
      lastRecoveryFailure = failure;
      lastRecoveryResult = "failed";
      recordTransition("failed", failure);
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

    // Reload is only transport recovery. Resume the exact same Stop -> settle ->
    // safety -> nudge transaction used by an ordinary stall instead of maintaining
    // a second implementation with subtly different rules.
    RELOAD_STATE.updateStage?.("resume-transaction", { turnKey: marker.turnKey });
    const finalKey = marker.turnKey;
    const ok = await runRecoveryTransaction({
      id: marker.conversationId,
      key: finalKey,
      allowReload: false,
      waitForModelHydration: true
    });

    if (!ok && composerContainsOnlyNudge()) clearNudge();
    rememberAttempt(marker.conversationId, finalKey);
    finishReloadMarker(ok);
    lastRecoveryResult = ok ? "completed" : "failed";
    recordTransition(lastRecoveryResult, ok ? lastSettlementSource : lastRecoveryFailure);
    lastRecoveryFinishedAt = Date.now();
    clearTransaction();
    scheduleSync();
  }

  function teardown() {
    monitorGeneration++;
    clearDeadlineTimer();
    clearCountdownTimer();
    clearTerminalEmptyTimer();
    if (activityObserver) activityObserver.disconnect();
    if (rootObserver) rootObserver.disconnect();
    activityObserver = null;
    rootObserver = null;
    activeTurn = null;
    activeTurnKey = null;
    transaction = null;
    terminalEmptyCandidateKey = null;
    terminalEmptySince = 0;
    publishStatus();
  }

  function startObservers() {
    if (!document.documentElement) return;
    if (!rootObserver) {
      rootObserver = new MutationObserver((records) => {
        if (records?.length && records.every(mutationIsOnlyOwnStatusUi)) return;
        scheduleSync();
      });
      rootObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["inert", "data-stream-active", "data-streaming-response-status"] });
    }
    scheduleSync();
  }

  async function start() {
    let stored = {};
    try { stored = await ext.storage.local.get(DEFAULTS); } catch { /* defaults */ }
    applySettings(stored);
    ext.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local") return;
      const next = {};
      let relevant = false;
      if (changes.stallRecoveryEnabled) { next.stallRecoveryEnabled = changes.stallRecoveryEnabled.newValue; relevant = true; }
      if (changes.stallRecoveryTimeoutSeconds) { next.stallRecoveryTimeoutSeconds = changes.stallRecoveryTimeoutSeconds.newValue; relevant = true; }
      if (!relevant) return;
      applySettings(next);
      if (!settings.stallRecoveryEnabled) teardown();
      else { startObservers(); scheduleSync(); }
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
        attemptedCurrentTurn: attemptedCurrentTurn(),
        stopUiSettled: stopUiSettled(),
        domStopSettled: domStopSettled(),
        composerIdle: composerIdle(),
        shellLoading: shellRunLoading(),
        assistantOutputPresent: hasAssistantOutput(),
        newestAssistantHasFinalOutput: hasSubstantiveFinalOutput(newestAssistantTurn()),
        newestAssistantHasFinalOutputRegion: hasFinalOutputRegion(newestAssistantTurn()),
        newestAssistantIncompleteEvidence: hasIncompleteTerminalEvidence(newestAssistantTurn()),
        terminalEmptyCandidateKey,
        terminalEmptySince,
        emptyCompletionRecoveryCount,
        emptyCompletionRetryLimit: EMPTY_COMPLETION_RETRY_LIMIT,
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
        lastTriggerBackendStatus,
        lastSettlementSource,
        lastProgressAt,
        activeTurnStartedAt,
        shellLoadingStartedAt,
        attemptedTurnKey,
        attemptedTurnCount: attemptedTurns.size,
        settledTurnCount: settledTurns.size,
        timeoutSeconds: settings.stallRecoveryTimeoutSeconds,
        phaseTimeoutSeconds: PHASE_TIMEOUT_MS / 1000,
        streamStatusTimeoutSeconds: STREAM_STATUS_TIMEOUT_MS / 1000,
        sendConfirmTimeoutSeconds: SEND_CONFIRM_TIMEOUT_MS / 1000,
        reloadMarker: RELOAD_STATE?.read?.() || null,
        composerInput: COMPOSER_INPUT?.debug?.() || { present: !!COMPOSER_INPUT },
        transitions: transitionLog.slice()
      };
    }
  };

  start();
})();
