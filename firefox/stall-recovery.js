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
  const STALL_STATUS_EVENT = "__gpt_anticurse_stall_status__";
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

  function recoveryRemainingMs() {
    if (recoveringTurns.size || recoveryPhase) return null;
    if (!activeTurn || !stopButton()) return null;
    if (recoveryModelState().autoRecoveryAllowed !== true) return null;
    if (hasLongWaitBanner(activeTurn)) return 0;
    if (shellLoading() || preOutputLoading(activeTurn)) return null;
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
    if (!recoveryPhase && !modelBlocked && !longWaitBanner && !loading) {
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
    if (shellLoading() || preOutputLoading(activeTurn)) { publishRecoveryStatus(); return; }
    const elapsed = Date.now() - lastActivityAt;
    const delay = delayOverride == null
      ? (hasLongWaitBanner(activeTurn) ? 0 : Math.max(0, thresholdMs() - elapsed))
      : Math.max(0, delayOverride);
    stallTimer = setTimeout(checkForStall, delay);
    publishRecoveryStatus();
  }

  function markActivity() {
    // DOM churn caused by our own Stop → Send transaction is not new model
    // progress and must not restart the stall deadline or cancel the transaction.
    if (recoveringTurns.size) { publishRecoveryStatus(); return; }
    lastActivityAt = Date.now();
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
    activityObserver = new MutationObserver((records) => {
      // This explicit ChatGPT long-wait UI is a stall signal, not progress.
      // React inserting/animating it must not restart the ordinary deadline.
      if (hasLongWaitBanner(activeTurn)) { scheduleStallCheck(0); return; }
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

  function findTurnByKey(key) {
    if (!key) return null;
    for (const turn of document.querySelectorAll(TURN_CONTAINER_SELECTOR)) {
      if (turnKey(turn) === key) return turn;
    }
    return null;
  }

  function originalTurnStillStreaming(key) {
    const turn = findTurnByKey(key);
    return !!turn && !!turn.querySelector(STREAMING_SELECTOR);
  }

  async function waitForStopSettlement(id, key) {
    // ChatGPT can remove the Stop button immediately while the server spends
    // tens of seconds cancelling a long tool/reasoning run. Do not type the
    // nudge during that limbo state: wait for both the Stop control and the
    // original streaming marker to settle.
    const settledInDom = await waitForCondition(
      () => !stopButton() && !originalTurnStillStreaming(key),
      document.documentElement,
      STOP_SETTLE_TIMEOUT_MS
    );
    if (settledInDom) return true;

    // If React left stale streaming DOM behind, one backend check may still
    // prove cancellation completed. Never proceed when the backend still says
    // the original request is streaming or when its state is unknown.
    const status = await streamStatus(id);
    return status !== null && status !== "IS_STREAMING";
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
    node.focus({ preventScroll: true });
    const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "." });
    if (!node.dispatchEvent(before)) return false;
    const paragraph = document.createElement("p");
    paragraph.textContent = ".";
    node.replaceChildren(paragraph);
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "." }));
    return (node.textContent || "").trim() === ".";
  }

  function clearSyntheticNudge() {
    const node = composer();
    if (!node || !node.isConnected || !composerContainsOnlyNudge()) return false;
    const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward", data: null });
    if (!node.dispatchEvent(before)) return false;
    node.replaceChildren();
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
    return !(node.textContent || "").trim();
  }

  async function sendNudge(originalKey) {
    if (hasUserDraft()) return false;
    const input = composer();
    if (!replaceComposerWithNudge(input)) return false;
    // Yield out of the input event without relying on requestAnimationFrame:
    // rAF is suspended for background tabs, while a microtask still runs.
    await new Promise((resolve) => queueMicrotask(resolve));
    // The user can type during this transition. Never send if the composer changed
    // from AntiCurse's exact fixed nudge or gained an attachment.
    if (!composerContainsOnlyNudge()) return false;

    // ChatGPT can keep Send disabled while the composer is empty and enable or
    // replace it only after the input event. Insert the nudge first, then wait.
    const submitReady = await waitForCondition(() => {
      if (!composerContainsOnlyNudge()) return false;
      const candidate = document.querySelector(SUBMIT_SELECTOR);
      return !!candidate && !candidate.disabled && candidate.getAttribute("aria-disabled") !== "true";
    }, input.closest("form") || document.documentElement, SEND_READY_TIMEOUT_MS);
    if (!submitReady || !composerContainsOnlyNudge()) return false;

    const submit = document.querySelector(SUBMIT_SELECTOR);
    if (!submit || submit.disabled || submit.getAttribute("aria-disabled") === "true") return false;
    // At this point Stop has settled and is absent. A newly appearing Stop
    // button therefore belongs to the resumed request. Alternatively accept a
    // different streaming turn key. Do not accept the old turn's stale marker.
    setRecoveryPhase("confirming");
    submit.click();

    // The Pro/unknown click guard can synchronously cancel our synthetic Send.
    // If it did, fail immediately instead of holding a synthetic dot for the
    // whole confirmation timeout.
    const postClickModel = recoveryModelState();
    if (composerContainsOnlyNudge() && postClickModel.autoRecoveryAllowed !== true) return false;

    return waitForCondition(
      () => !!stopButton() || (() => {
        const live = findActiveTurn();
        const liveKey = turnKey(live);
        return !!liveKey && liveKey !== originalKey;
      })(),
      document.documentElement,
      SEND_CONFIRM_TIMEOUT_MS
    );
  }

  async function recoverStall(id, key, generation) {
    const identity = `${id || ""}\u001f${key || ""}`;
    if (generation !== recoveryGeneration || key !== activeTurnKey || attemptedTurns.has(identity) || recoveringTurns.has(identity)) return;
    if (hasUserDraft()) { scheduleStallCheck(30_000); return; }
    const stop = stopButton();
    if (!stop) return;
    recoveringTurns.add(identity);
    attemptedTurnKey = key;
    recoveryStartedAt = Date.now();
    lastRecoveryResult = "in-flight";
    lastRecoveryFailure = null;
    setRecoveryPhase("stopping");
    try {
      stop.click();
      if (!(await waitForStopSettlement(id, key))) { lastRecoveryFailure = "stop-not-settled"; return; }
      if (!settings.stallRecoveryEnabled || conversationId() !== id || generation !== recoveryGeneration) {
        lastRecoveryFailure = "transaction-invalidated";
        return;
      }
      if (hasUserDraft()) { lastRecoveryFailure = "user-draft-during-stop"; return; }
      if (recoveryModelState().autoRecoveryAllowed !== true) { lastRecoveryFailure = "model-blocked-after-stop"; return; }
      setRecoveryPhase("sending");
      if (!(await sendNudge(key))) { lastRecoveryFailure = "nudge-send-failed"; return; }
      attemptedTurns.add(identity);
      lastRecoveryResult = "completed";
      if (attemptedTurns.size > 256) attemptedTurns.delete(attemptedTurns.values().next().value);
    } finally {
      if (lastRecoveryResult !== "completed") lastRecoveryResult = "failed";
      lastRecoveryFinishedAt = Date.now();
      // Remove only AntiCurse's exact synthetic nudge after a failed Send. Never
      // touch a composer that the user changed while recovery was in flight.
      if (lastRecoveryResult !== "completed") clearSyntheticNudge();
      recoveringTurns.delete(identity);
      // Never reload the chat as a recovery fallback. A failed transient UI
      // transition is not permanently recorded as an attempted turn.
      setRecoveryPhase(null);
      // Reconcile whatever ChatGPT mounted while recovery owned the old turn.
      syncActiveTurn();
    }
  }

  async function checkForStall() {
    stallTimer = null;
    if (!settings.stallRecoveryEnabled || !activeTurn || !stopButton()) return;
    if (recoveryModelState().autoRecoveryAllowed !== true) { publishRecoveryStatus(); return; }
    if (shellLoading() || preOutputLoading(activeTurn)) { publishRecoveryStatus(); return; }

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

    if (settings.stallRecoveryEnabled) scheduleDiscovery();
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
        attemptedTurnKey,
        attemptedTurnCount: attemptedTurns.size,
        recoveryInFlightCount: recoveringTurns.size,
        recoveryStopSettleTimeoutSeconds: STOP_SETTLE_TIMEOUT_MS / 1000,
        recoverySendReadyTimeoutSeconds: SEND_READY_TIMEOUT_MS / 1000,
        recoverySendConfirmTimeoutSeconds: SEND_CONFIRM_TIMEOUT_MS / 1000,
        timeoutSeconds: STALL_TIMEOUT_MS / 1000,
        turnListObserver: !!turnListObserver,
        shellObserverCount: shellObservers.length,
        discoveryObserver: !!discoveryObserver
      };
    }
  };

  start();
})();
