/* Recover non-Pro turns that end without a useful assistant answer. */
(() => {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const SESSION_AUTH = globalThis.CGAntiCurseSessionAuth;
  const GUARD = globalThis.CGAntiCurseProRecoveryGuard;
  const COMPOSER_INPUT = globalThis.CGAntiCurseComposerInput;
  const DELIVERY = globalThis.CGAntiCurseDeliveryTimeoutReload;
  const TURN_CONTAINER_SELECTOR = '[data-turn-id-container]';
  const STREAMING_SELECTOR = '[data-streaming-response-status]';
  const STOP_SELECTOR = '#composer-submit-button[data-testid="stop-button"]';
  const SUBMIT_SELECTOR = '#composer-submit-button:not([data-testid="stop-button"])';
  const COMPOSER_SELECTOR = '#prompt-textarea[contenteditable="true"]';
  const DELIVERY_CONSUMED_PREFIX = "cg-anticurse-post-run-delivery-consumed:";
  const DELIVERY_INTENT_TTL_MS = 10 * 60_000;
  const STOP_SETTLE_TIMEOUT_MS = 120_000;
  const SEND_READY_TIMEOUT_MS = 30_000;
  const SEND_CONFIRM_TIMEOUT_MS = 30_000;
  const BACKEND_POLL_MS = 1_500;

  let settings = { stallRecoveryEnabled: true };
  let observer = null;
  let activeSnapshot = null;
  let handling = false;
  let manualStopKey = null;
  let manualStopAt = 0;
  let pollTimer = null;
  let lastAction = null;
  let lastReason = null;
  let lastFailure = null;
  let lastHandledTurnKey = null;
  let lastDeliveryLatchAt = null;
  let resumeAttempts = 0;
  let resumeSuccesses = 0;
  let manualStopSuppressions = 0;

  function conversationId() {
    const match = location.pathname.match(/^\/(?:c|branch)\/([^/?#]+)/);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch { return null; }
  }

  function stopButton() { return document.querySelector(STOP_SELECTOR); }
  function composer() { return document.querySelector(COMPOSER_SELECTOR); }
  function draftText() { const node = composer(); return node ? String(node.textContent || "").trim() : ""; }
  function hasUserDraft() { return !!draftText(); }
  function composerContainsOnlyNudge() { return draftText() === "."; }

  function turnKey(turn) {
    if (!turn) return null;
    const section = turn.matches?.('[data-testid^="conversation-turn-"]')
      ? turn
      : turn.querySelector?.('[data-testid^="conversation-turn-"]');
    return (section && (section.getAttribute("data-turn-id") || section.getAttribute("data-testid"))) ||
      turn.getAttribute?.("data-turn-id-container") || null;
  }

  function activeStreamingTurn() {
    const turns = document.querySelectorAll(TURN_CONTAINER_SELECTOR);
    for (let index = turns.length - 1; index >= 0; index--) {
      if (turns[index].querySelector(STREAMING_SELECTOR)) return turns[index];
    }
    return null;
  }

  function latestAssistantTurn() {
    const turns = document.querySelectorAll(TURN_CONTAINER_SELECTOR);
    for (let index = turns.length - 1; index >= 0; index--) {
      const turn = turns[index];
      if (turn.parentElement?.closest?.(TURN_CONTAINER_SELECTOR)) continue;
      if (turn.querySelector('[data-turn="assistant"], section[data-turn="assistant"], [data-message-author-role="assistant"]')) return turn;
    }
    return null;
  }

  function hasUsefulAssistantAnswer(turn) {
    if (!turn) return false;
    // ChatGPT's actual assistant answer body is structurally separate from
    // thinking/tool/status UI. Do not count arbitrary wrapper text as an answer.
    for (const body of turn.querySelectorAll('[data-message-author-role="assistant"] .markdown.prose, [id^="textdoc-message-"] .ProseMirror')) {
      if (String(body.textContent || "").trim()) return true;
      if (body.querySelector?.("img, video, audio, pre, code, table")) return true;
    }
    // A media-only assistant result is also useful even when no Markdown body is present.
    const assistant = turn.querySelector('[data-message-author-role="assistant"]');
    return !!assistant?.querySelector("img, video, audio");
  }

  function modelState() {
    if (!GUARD || typeof GUARD.activeRecoveryState !== "function") return { decision: "unknown", autoRecoveryAllowed: false };
    try {
      const state = GUARD.activeRecoveryState();
      return state && typeof state === "object" ? state : { decision: "unknown", autoRecoveryAllowed: false };
    } catch {
      return { decision: "unknown", autoRecoveryAllowed: false };
    }
  }

  function snapshotApproval(state, key) {
    return {
      turnKey: key || state?.turnKey || null,
      modelSlug: state?.modelSlug || null,
      selectedModelLabel: state?.selectedModelLabel || null,
      selectedModelLane: state?.selectedModelLane || null,
      decision: "non-pro",
      detectionSource: state?.detectionSource || "post-run"
    };
  }

  function latestAssistantModelSlug() {
    const latest = latestAssistantTurn();
    if (!latest) return null;
    const nodes = latest.querySelectorAll('[data-message-model-slug]');
    for (let index = nodes.length - 1; index >= 0; index--) {
      const slug = String(nodes[index].getAttribute("data-message-model-slug") || "").trim();
      if (slug) return slug;
    }
    return null;
  }

  function approvalForCurrentPage(key = null) {
    const state = modelState();
    if (state.autoRecoveryAllowed === true) return snapshotApproval(state, key || state.turnKey);
    if (state.decision === "pro") return null;
    const slug = latestAssistantModelSlug();
    if (!slug || !GUARD || typeof GUARD.modelSlugIsPro !== "function" || GUARD.modelSlugIsPro(slug)) return null;
    return {
      turnKey: key,
      modelSlug: slug,
      selectedModelLabel: state.selectedModelLabel || null,
      selectedModelLane: state.selectedModelLane || null,
      decision: "non-pro",
      detectionSource: "latest-assistant-model-slug"
    };
  }

  function stallTransactionActive() {
    const recovery = globalThis.CGAntiCurseStallRecovery;
    if (!recovery || typeof recovery.debug !== "function") return false;
    try {
      const state = recovery.debug();
      return !!state?.recoveryPhase || Number(state?.recoveryInFlightCount || 0) > 0;
    } catch {
      return false;
    }
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

  function waitForCondition(test, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = (value) => {
        if (done) return;
        done = true;
        observerLocal.disconnect();
        if (timer !== null) clearTimeout(timer);
        resolve(value);
      };
      const observerLocal = new MutationObserver(() => {
        try { if (test()) finish(true); } catch { /* continue */ }
      });
      try { if (test()) { resolve(true); return; } } catch { /* continue */ }
      observerLocal.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  function restoreApproval(approval) {
    if (!GUARD || typeof GUARD.restoreRecoveryHandoff !== "function") return false;
    try { return GUARD.restoreRecoveryHandoff(approval)?.autoRecoveryAllowed === true; }
    catch { return false; }
  }

  function armNudge(key) {
    if (!GUARD || typeof GUARD.armRecoveryNudge !== "function") return false;
    try { return GUARD.armRecoveryNudge(key)?.autoRecoveryAllowed === true; }
    catch { return false; }
  }

  function clearNudge() {
    const input = composer();
    if (!input || !composerContainsOnlyNudge()) return false;
    if (COMPOSER_INPUT && typeof COMPOSER_INPUT.clearExactText === "function") {
      try { if (COMPOSER_INPUT.clearExactText(input, ".")) return true; } catch { /* fallback */ }
    }
    input.replaceChildren();
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
    return !draftText();
  }

  async function sendNudge(approval) {
    if (hasUserDraft() || modelState().decision === "pro") { lastFailure = "draft-or-pro-before-send"; return false; }
    if (!restoreApproval(approval)) { lastFailure = "handoff-restore-rejected"; return false; }
    const input = composer();
    if (!input || !input.isConnected || draftText()) { lastFailure = "composer-not-empty"; return false; }

    let inserted = false;
    if (COMPOSER_INPUT && typeof COMPOSER_INPUT.insertText === "function") {
      try { inserted = COMPOSER_INPUT.insertText(input, "."); } catch { inserted = false; }
    }
    if (!inserted) {
      input.focus({ preventScroll: true });
      const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "." });
      if (!input.dispatchEvent(before)) { lastFailure = "insert-beforeinput-blocked"; return false; }
      const p = document.createElement("p");
      p.textContent = ".";
      input.replaceChildren(p);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "." }));
    }
    await new Promise((resolve) => queueMicrotask(resolve));
    if (!composerContainsOnlyNudge()) { lastFailure = "insert-reverted"; return false; }

    const ready = await waitForCondition(() => {
      const submit = document.querySelector(SUBMIT_SELECTOR);
      return composerContainsOnlyNudge() && !!submit && !submit.disabled && submit.getAttribute("aria-disabled") !== "true";
    }, SEND_READY_TIMEOUT_MS);
    if (!ready || !composerContainsOnlyNudge()) { lastFailure = "send-not-ready"; clearNudge(); return false; }
    if (!armNudge(approval.turnKey || null)) { lastFailure = "guard-not-armed"; clearNudge(); return false; }

    const submit = document.querySelector(SUBMIT_SELECTOR);
    if (!submit) { lastFailure = "send-button-missing"; clearNudge(); return false; }
    submit.click();
    const confirmed = await waitForCondition(() => !!stopButton() || (() => {
      const live = activeStreamingTurn();
      const key = turnKey(live);
      return !!key && key !== approval.turnKey;
    })(), SEND_CONFIRM_TIMEOUT_MS);
    if (!confirmed) { lastFailure = "send-not-confirmed"; clearNudge(); return false; }
    return true;
  }

  async function stopIfStillRunning(id, approval) {
    const status = await streamStatus(id);
    const running = !!stopButton() || status === "IS_STREAMING";
    if (!running) return true;
    const state = modelState();
    if (state.autoRecoveryAllowed !== true) { lastFailure = state.decision === "pro" ? "pro-before-stop" : "model-unknown-before-stop"; return false; }
    const stop = stopButton();
    if (!stop) {
      const appeared = await waitForCondition(() => !!stopButton(), 10_000);
      if (!appeared) { lastFailure = "running-without-stop"; return false; }
    }
    const liveApproval = snapshotApproval(modelState(), turnKey(activeStreamingTurn()) || approval.turnKey);
    const button = stopButton();
    if (!button) { lastFailure = "stop-missing"; return false; }
    button.click();
    const deadline = Date.now() + STOP_SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (modelState().decision === "pro") { lastFailure = "pro-during-stop"; return false; }
      const current = await streamStatus(id);
      if (current !== "IS_STREAMING" && current !== null) {
        approval.turnKey = liveApproval.turnKey;
        approval.modelSlug = liveApproval.modelSlug;
        approval.selectedModelLabel = liveApproval.selectedModelLabel;
        approval.selectedModelLane = liveApproval.selectedModelLane;
        return true;
      }
      if (!stopButton() && document.querySelector(SUBMIT_SELECTOR) && current === null) return true;
      await new Promise((resolve) => setTimeout(resolve, BACKEND_POLL_MS));
    }
    lastFailure = "stop-not-settled";
    return false;
  }

  function deliveryIntent() {
    if (!DELIVERY || typeof DELIVERY.debug !== "function") return null;
    let state;
    try { state = DELIVERY.debug(); } catch { return null; }
    const latch = state?.latch;
    const id = conversationId();
    const at = Number(latch?.at || 0);
    if (!id || !at || Date.now() - at > DELIVERY_INTENT_TTL_MS) return null;
    // Only a latch written before this navigation is evidence that the current
    // page is the result of the detector's reload, not the page about to reload.
    if (at >= Number(performance.timeOrigin || 0)) return null;
    const token = `${at}:${String(latch.messageId || "")}`;
    try {
      if (sessionStorage.getItem(`${DELIVERY_CONSUMED_PREFIX}${id}`) === token) return null;
    } catch { return null; }
    return { id, at, token };
  }

  function consumeDeliveryIntent(intent) {
    try {
      sessionStorage.setItem(`${DELIVERY_CONSUMED_PREFIX}${intent.id}`, intent.token);
      return true;
    } catch {
      return false;
    }
  }

  async function handleDeliveryIntent(intent) {
    if (!intent || handling || !settings.stallRecoveryEnabled) return;
    handling = true;
    lastReason = "retryable-network-error";
    lastAction = "delivery-followup";
    lastFailure = null;
    lastDeliveryLatchAt = intent.at;
    resumeAttempts++;
    try {
      const ready = await waitForCondition(() => !!composer() && document.readyState !== "loading", 30_000);
      if (!ready || conversationId() !== intent.id || hasUserDraft()) { lastFailure = "delivery-page-not-ready"; return; }
      const approval = approvalForCurrentPage(turnKey(activeStreamingTurn()) || turnKey(latestAssistantTurn()));
      if (!approval) { lastFailure = modelState().decision === "pro" ? "delivery-pro" : "delivery-model-unknown"; return; }
      if (!consumeDeliveryIntent(intent)) { lastFailure = "delivery-consume-failed"; return; }
      if (!(await stopIfStillRunning(intent.id, approval))) return;
      if (hasUserDraft()) { lastFailure = "user-draft-after-stop"; return; }
      if (await sendNudge(approval)) {
        resumeSuccesses++;
        lastHandledTurnKey = approval.turnKey || null;
        lastAction = "delivery-resumed";
      }
    } finally {
      handling = false;
    }
  }

  async function handleIncompleteEnd(snapshot) {
    if (!snapshot || handling || !settings.stallRecoveryEnabled || stallTransactionActive()) return;
    if (snapshot.sawUsefulAnswer || hasUserDraft()) return;
    if (manualStopKey === snapshot.turnKey && Date.now() - manualStopAt < 30_000) {
      manualStopSuppressions++;
      activeSnapshot = null;
      return;
    }
    handling = true;
    lastReason = "ended-without-useful-answer";
    lastAction = "checking-ended-turn";
    lastFailure = null;
    resumeAttempts++;
    try {
      const id = snapshot.conversationId;
      if (!id || conversationId() !== id) return;
      // Give React/backend a brief chance to finish the terminal transition.
      let status = await streamStatus(id);
      const deadline = Date.now() + 30_000;
      while (status === "IS_STREAMING" && Date.now() < deadline && !stopButton()) {
        await new Promise((resolve) => setTimeout(resolve, BACKEND_POLL_MS));
        status = await streamStatus(id);
      }
      if (status === "IS_STREAMING" || stopButton()) return;
      const latest = latestAssistantTurn();
      if (hasUsefulAssistantAnswer(latest)) return;
      if (hasUserDraft() || modelState().decision === "pro") return;
      if (await sendNudge(snapshot.approval)) {
        resumeSuccesses++;
        lastHandledTurnKey = snapshot.turnKey || null;
        lastAction = "incomplete-turn-resumed";
      }
    } finally {
      if (activeSnapshot === snapshot) activeSnapshot = null;
      handling = false;
    }
  }

  function captureOrFinishRun() {
    if (!settings.stallRecoveryEnabled || handling) return;
    const live = activeStreamingTurn();
    const stop = stopButton();
    if (live && stop) {
      const state = modelState();
      if (state.autoRecoveryAllowed !== true) {
        if (state.decision === "pro") activeSnapshot = null;
        return;
      }
      const key = turnKey(live) || state.turnKey;
      if (!activeSnapshot || activeSnapshot.conversationId !== conversationId() || activeSnapshot.turnKey !== key) {
        activeSnapshot = {
          conversationId: conversationId(),
          turnKey: key || null,
          approval: snapshotApproval(state, key),
          sawUsefulAnswer: hasUsefulAssistantAnswer(live),
          capturedAt: Date.now()
        };
      } else if (hasUsefulAssistantAnswer(live)) {
        activeSnapshot.sawUsefulAnswer = true;
      }
      return;
    }

    if (!stop && activeSnapshot) {
      if (hasUsefulAssistantAnswer(latestAssistantTurn())) activeSnapshot.sawUsefulAnswer = true;
      if (!activeSnapshot.sawUsefulAnswer) queueMicrotask(() => handleIncompleteEnd(activeSnapshot));
      else activeSnapshot = null;
    }
  }

  function schedulePoll() {
    if (pollTimer !== null) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      captureOrFinishRun();
      const intent = deliveryIntent();
      if (intent) handleDeliveryIntent(intent);
    }, 750);
  }

  document.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const stop = target.closest(STOP_SELECTOR);
    if (!stop) return;
    const live = activeStreamingTurn();
    manualStopKey = turnKey(live) || activeSnapshot?.turnKey || null;
    manualStopAt = Date.now();
  }, true);

  function startObserver() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(schedulePoll);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    captureOrFinishRun();
    const intent = deliveryIntent();
    if (intent) queueMicrotask(() => handleDeliveryIntent(intent));
  }

  ext.storage?.local?.get?.({ stallRecoveryEnabled: true }).then((stored) => {
    settings.stallRecoveryEnabled = stored?.stallRecoveryEnabled !== false;
    if (settings.stallRecoveryEnabled) startObserver();
  }).catch(() => startObserver());

  ext.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes.stallRecoveryEnabled) return;
    settings.stallRecoveryEnabled = changes.stallRecoveryEnabled.newValue !== false;
    if (settings.stallRecoveryEnabled) startObserver();
    else {
      if (observer) observer.disconnect();
      observer = null;
      activeSnapshot = null;
    }
  });

  globalThis.CGAntiCursePostRunRecovery = Object.freeze({
    hasUsefulAssistantAnswer,
    debug() {
      return {
        enabled: settings.stallRecoveryEnabled,
        observerActive: !!observer,
        handling,
        activeTurnKey: activeSnapshot?.turnKey || null,
        activeSawUsefulAnswer: activeSnapshot?.sawUsefulAnswer ?? null,
        manualStopKey,
        manualStopAt,
        lastAction,
        lastReason,
        lastFailure,
        lastHandledTurnKey,
        lastDeliveryLatchAt,
        resumeAttempts,
        resumeSuccesses,
        manualStopSuppressions
      };
    }
  });
})();
