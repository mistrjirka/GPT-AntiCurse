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
  const STALL_STATUS_EVENT = "__gpt_anticurse_stall_status__";
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const TURN_CONTAINER_SELECTOR = '[data-turn-id-container]';
  const STREAMING_SELECTOR = '[data-streaming-response-status]';
  const STOP_SELECTOR = '#composer-submit-button[data-testid="stop-button"], button[data-testid="stop-button"]';
  const SUBMIT_SELECTOR = '#composer-submit-button[data-testid="send-button"], button[data-testid="send-button"], #composer-submit-button:not([data-testid="stop-button"])';
  const COMPOSER_SELECTOR = '#prompt-textarea[contenteditable="true"]';

  let settings = { ...DEFAULTS };
  let turnList = null;
  let turnListObserver = null;
  let shellObservers = [];
  let shellRefreshQueued = false;
  let activeTurn = null;
  let activityObserver = null;
  let activeTurnKey = null;
  let lastActivityAt = 0;
  let stallTimer = null;
  let recoveryGeneration = 0;
  let attemptedTurnKey = null;
  const attemptedTurns = new Set();
  let candidateTurn = null;
  let candidateObserver = null;
  let discoveryObserver = null;
  let discoveryTimer = null;
  let countdownUiTimer = null;
  let recoveryPhase = null;
  let stallCheckInFlight = false;
  let backgroundWakeDueAt = null;

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

  function clearCountdownUiTimer() {
    if (countdownUiTimer !== null) clearTimeout(countdownUiTimer);
    countdownUiTimer = null;
  }

  function recoveryRemainingMs() {
    if (!activeTurn || !activeTurn.querySelector(STREAMING_SELECTOR)) return null;
    if (hasLongWaitBanner(activeTurn)) return 0;
    return Math.max(0, thresholdMs() - (Date.now() - lastActivityAt));
  }

  function publishRecoveryStatus() {
    clearCountdownUiTimer();
    const id = conversationId();
    const active = settings.stallRecoveryEnabled && !!activeTurn && !!activeTurn.querySelector(STREAMING_SELECTOR);
    if (!active) {
      recoveryPhase = null;
      window.dispatchEvent(new CustomEvent(STALL_STATUS_EVENT, { detail: { active: false, conversationId: id } }));
      return;
    }

    const longWaitBanner = hasLongWaitBanner(activeTurn);
    const tool = runningTool(activeTurn);
    const draftBlocked = hasUserDraft();
    const hidden = document.visibilityState !== "visible";
    const remainingMs = recoveryRemainingMs();
    const phase = recoveryPhase ||
      (draftBlocked ? "paused-draft" : longWaitBanner ? "checking" : "countdown");

    window.dispatchEvent(new CustomEvent(STALL_STATUS_EVENT, { detail: {
      active: true,
      conversationId: id,
      phase,
      remainingMs,
      tool,
      longWaitBanner,
      draftBlocked,
      hidden,
      stopButton: !!stopButton()
    } }));

    // Recovery itself stays deadline/event-driven. This timer only refreshes the
    // visible countdown while a streaming turn exists.
    // Do not run a cosmetic 1 Hz timer in a hidden tab. The actual watchdog has
    // its own deadline timer and uses Date.now(), so it keeps running/catches up
    // without creating a chain of background timers that browsers may throttle.
    if (!recoveryPhase && !longWaitBanner && !hidden) countdownUiTimer = setTimeout(publishRecoveryStatus, 1000);
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

  function sendRuntimeMessage(message) {
    try {
      const result = ext.runtime.sendMessage(message);
      if (result && typeof result.catch === "function") result.catch((error) => console.debug("[GPT AntiCurse] stall alarm message failed", error));
    } catch { /* background wake-up is a reliability backup only */ }
  }

  function scheduleBackgroundWakeup(dueAt) {
    if (!Number.isFinite(dueAt)) return;
    // Do not re-arm the extension alarm for every streamed token. An existing
    // earlier alarm is a safe checkpoint: when it fires we recompute the true
    // remaining time from Date.now() and the latest activity timestamp.
    if (Number.isFinite(backgroundWakeDueAt) && backgroundWakeDueAt <= dueAt) return;
    backgroundWakeDueAt = dueAt;
    sendRuntimeMessage({ type: "cg-stall-alarm-schedule", dueAt });
  }

  function clearBackgroundWakeup() {
    if (backgroundWakeDueAt == null) return;
    backgroundWakeDueAt = null;
    sendRuntimeMessage({ type: "cg-stall-alarm-clear" });
  }

  function stopButton() { return document.querySelector(STOP_SELECTOR); }
  function submitButton() { return document.querySelector(SUBMIT_SELECTOR); }
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

  function runningTool(turn = activeTurn) {
    if (!turn) return false;
    const iconSelector = '[data-testid="cot-v5-tool-icon-pile"], [data-testid*="tool-icon"]';
    for (const shimmer of turn.querySelectorAll(".loading-shimmer-tertiary")) {
      // Current ChatGPT nests the shimmer text inside two small layout wrappers;
      // the tool icon is a sibling under their common parent. Walk only a few
      // local ancestors so completed tool cards elsewhere in the turn do not
      // accidentally extend the timeout.
      let node = shimmer.parentElement;
      for (let depth = 0; node && node !== turn && depth < 4; depth++, node = node.parentElement) {
        if (node.querySelector(iconSelector)) return true;
      }
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
    if (!settings.stallRecoveryEnabled || !activeTurn || !activeTurn.querySelector(STREAMING_SELECTOR)) {
      clearBackgroundWakeup();
      publishRecoveryStatus();
      return;
    }
    const elapsed = Date.now() - lastActivityAt;
    const delay = delayOverride == null
      ? (hasLongWaitBanner(activeTurn) ? 0 : Math.max(0, thresholdMs() - elapsed))
      : Math.max(0, delayOverride);
    const dueAt = Date.now() + delay;
    stallTimer = setTimeout(checkForStall, delay);
    // Browser-extension alarms are not subject to the same background-tab timer
    // throttling as this content script. Keep one per tab as a wake-up backup.
    scheduleBackgroundWakeup(dueAt);
    publishRecoveryStatus();
  }

  function markActivity() {
    lastActivityAt = Date.now();
    recoveryGeneration++;
    recoveryPhase = null;
    scheduleStallCheck();
  }

  function observeActiveTurn(turn) {
    if (activeTurn === turn) return;
    const nextKey = turnKey(turn);
    const nextIdentity = nextKey ? `${conversationId() || ""}\u001f${nextKey}` : null;
    const sameLogicalTurn = !!nextIdentity && nextIdentity === observeActiveTurn.lastIdentity;
    if (activityObserver) activityObserver.disconnect();
    activityObserver = null;
    activeTurn = turn || null;
    activeTurnKey = nextKey;
    clearTimer();
    recoveryGeneration++;
    recoveryPhase = null;
    if (!activeTurn) { clearBackgroundWakeup(); publishRecoveryStatus(); return; }

    // React may remount the same logical turn when a browser tab is hidden or
    // shown. A DOM-node replacement is not model progress, so preserve the
    // wall-clock deadline for the same conversation/turn identity.
    if (!sameLogicalTurn) {
      observeActiveTurn.lastIdentity = nextIdentity;
      lastActivityAt = Date.now();
    }
    activityObserver = new MutationObserver((records) => {
      if (!activeTurn?.querySelector(STREAMING_SELECTOR)) { syncActiveTurn(); return; }
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
  observeActiveTurn.lastIdentity = null;

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

  function disconnectCandidateObserver() {
    if (candidateObserver) candidateObserver.disconnect();
    candidateObserver = null;
    candidateTurn = null;
  }

  function latestTurnWrapper() {
    if (!turnList || !turnList.isConnected) return null;
    const children = Array.from(turnList.children);
    for (let index = children.length - 1; index >= 0; index--) {
      if (children[index].matches(TURN_CONTAINER_SELECTOR)) return children[index];
    }
    return null;
  }

  function watchLatestTurnForStreaming() {
    const latest = latestTurnWrapper();
    if (!latest || latest === candidateTurn) return;
    disconnectCandidateObserver();
    candidateTurn = latest;
    candidateObserver = new MutationObserver(() => {
      if (!candidateTurn || !candidateTurn.isConnected) { disconnectCandidateObserver(); scheduleDiscovery(); return; }
      if (!candidateTurn.querySelector(STREAMING_SELECTOR)) return;
      disconnectCandidateObserver();
      syncActiveTurn();
    });
    // This observer exists only while there is no detected active run, and only
    // on the newest turn. It closes the race where ChatGPT mounts the turn
    // wrapper before adding data-streaming-response-status inside it.
    candidateObserver.observe(candidateTurn, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-streaming-response-status"]
    });
  }

  function syncActiveTurn() {
    const next = findActiveTurn();
    if (next !== activeTurn) observeActiveTurn(next);
    if (next) disconnectCandidateObserver();
    else watchLatestTurnForStreaming();
  }

  function disconnectShellObservers() {
    for (const observer of shellObservers) observer.disconnect();
    shellObservers = [];
    shellRefreshQueued = false;
  }

  function scheduleShellRefresh() {
    if (shellRefreshQueued) return;
    shellRefreshQueued = true;
    queueMicrotask(() => {
      shellRefreshQueued = false;
      if (turnList && turnList.isConnected) return;
      turnList = null;
      disconnectCandidateObserver();
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
    // Current ChatGPT puts data-turn-id-container on both the section and its
    // outer turn wrapper. Prefer the matching parent so we observe the real list
    // of turns rather than accidentally treating one turn as the whole list.
    const wrapper = section && section.parentElement?.matches(TURN_CONTAINER_SELECTOR)
      ? section.parentElement
      : section && section.closest(TURN_CONTAINER_SELECTOR);
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

  async function interruptConversation(id) {
    if (!id || !SESSION_AUTH || typeof SESSION_AUTH.resolveAccessToken !== "function") return false;
    const auth = await SESSION_AUTH.resolveAccessToken({ isCurrent: () => conversationId() === id });
    if (!auth.ok || conversationId() !== id) return false;
    try {
      // This is the same backend route used by ChatGPT's current Stop action.
      // The conduit/turn-trace headers used by the site are optional; the
      // authenticated conversation id is sufficient for the fallback.
      const response = await fetch(`${location.origin}/backend-api/stop_conversation`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${auth.accessToken}`
        },
        body: JSON.stringify({ conversation_id: id, exclude_async_types: [] })
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  function onVisibilityChange() {
    // Visibility changes do not pause or restart the deadline. Re-evaluate from
    // Date.now() so a throttled background timer catches up immediately.
    if (activeTurn) scheduleStallCheck(0);
    else publishRecoveryStatus();
  }

  function onPotentialRunStart(event) {
    if (!settings.stallRecoveryEnabled) return;
    const target = event && event.target instanceof Element ? event.target : null;
    const isSubmit = event?.type === "submit" && !!target?.closest('form[data-type="unified-composer"], form');
    const isSendClick = event?.type === "click" && !!target?.closest('#composer-submit-button:not([data-testid="stop-button"])');
    const isComposerEnter = event?.type === "keydown" && event.key === "Enter" && !event.shiftKey && !!target?.closest(COMPOSER_SELECTOR);
    if (!isSubmit && !isSendClick && !isComposerEnter) return;
    // Discovery intentionally self-expires after 10 seconds when a page is idle.
    // Wake it whenever the user can start a new run so long-open/new-chat tabs
    // cannot permanently miss the watchdog.
    queueMicrotask(scheduleDiscovery);
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

  async function sendNudge() {
    if (hasUserDraft()) return false;
    const input = composer();
    if (!replaceComposerWithNudge(input)) return false;
    await Promise.resolve();
    // The user can type during this frame. Never send if the composer changed
    // from AntiCurse's exact fixed nudge or gained an attachment.
    if (!composerContainsOnlyNudge()) return false;

    // ChatGPT can keep Send disabled while the composer is empty and enable or
    // replace it only after the input event. Insert the nudge first, then wait.
    const submitReady = await waitForCondition(() => {
      if (!composerContainsOnlyNudge()) return false;
      const candidate = submitButton();
      return !!candidate && !candidate.disabled && candidate.getAttribute("aria-disabled") !== "true";
    }, input.closest("form") || document.documentElement, 3_000);
    if (!submitReady || !composerContainsOnlyNudge()) return false;

    const submit = submitButton();
    if (!submit || submit.disabled || submit.getAttribute("aria-disabled") === "true") return false;
    submit.click();
    return waitForCondition(
      () => !!stopButton() || !!document.querySelector(`${TURN_CONTAINER_SELECTOR} ${STREAMING_SELECTOR}`),
      document.documentElement,
      8_000
    );
  }

  async function recoverStall(id, key, generation, backendStatus = null) {
    const identity = `${id || ""}\u001f${key || ""}`;
    if (generation !== recoveryGeneration || key !== activeTurnKey || attemptedTurns.has(identity)) return;
    if (hasUserDraft()) { scheduleStallCheck(30_000); return; }

    setRecoveryPhase("recovering");
    attemptedTurns.add(identity);
    if (attemptedTurns.size > 256) attemptedTurns.delete(attemptedTurns.values().next().value);
    attemptedTurnKey = key;
    clearBackgroundWakeup();

    const stop = stopButton();
    if (stop) {
      stop.click();
      const stopped = await waitForCondition(() => !stopButton(), document.documentElement, 10_000);
      if (!stopped || hasUserDraft()) { setRecoveryPhase(null); return; }
    } else if (backendStatus === "IS_STREAMING") {
      // Live capture shows a real failure mode where the streaming marker stays
      // mounted but React no longer renders the Stop control. In that state use
      // ChatGPT's own current stop endpoint instead of waiting forever for a
      // button that may never return.
      if (!await interruptConversation(id) || hasUserDraft()) { setRecoveryPhase(null); return; }
    } else if (backendStatus == null) {
      // Without either a UI Stop control or a known backend state, fail closed.
      setRecoveryPhase(null);
      scheduleStallCheck(30_000);
      return;
    }

    // If the backend already reports a non-streaming state while the DOM still
    // carries a stale streaming marker, there is nothing left to stop. Sending
    // the fixed nudge is the recovery action itself.
    if (await sendNudge()) { setRecoveryPhase(null); return; }
    // Never reload the chat as a recovery fallback. If ChatGPT does not expose
    // a usable Send control, leave the page in place and fail safely.
    setRecoveryPhase(null);
  }

  async function checkForStall() {
    stallTimer = null;
    if (stallCheckInFlight) return;
    if (!settings.stallRecoveryEnabled || !activeTurn) return;
    if (!activeTurn.querySelector(STREAMING_SELECTOR)) { syncActiveTurn(); return; }

    const longWaitBanner = hasLongWaitBanner(activeTurn);
    const threshold = thresholdMs();
    if (!longWaitBanner) {
      const elapsed = Date.now() - lastActivityAt;
      if (elapsed < threshold) { scheduleStallCheck(threshold - elapsed); return; }
    }
    if (hasUserDraft()) { scheduleStallCheck(30_000); return; }

    stallCheckInFlight = true;
    try {
      const id = conversationId();
      const key = activeTurnKey;
      const generation = recoveryGeneration;
      const hadStopControl = !!stopButton();
      setRecoveryPhase("checking");

      // The explicit long-wait banner can still recover immediately through the
      // visible Stop button. If that control is absent, we need backend state so
      // the fallback never stops/sends blindly.
      let firstStatus = null;
      if (!longWaitBanner || !hadStopControl) firstStatus = await streamStatus(id);
      if (generation !== recoveryGeneration || key !== activeTurnKey) { setRecoveryPhase(null); return; }

      if (!longWaitBanner && firstStatus !== "IS_STREAMING") {
        // A stale DOM streaming marker + no Stop control + a definite backend
        // non-streaming state is exactly the live failure captured by the user.
        if (!stopButton() && firstStatus != null) {
          await recoverStall(id, key, generation, firstStatus);
          return;
        }
        setRecoveryPhase(null);
        scheduleStallCheck(30_000);
        return;
      }

      if (!longWaitBanner) {
        const graceMs = settings.stallRecoveryGraceSeconds * 1000;
        if (graceMs > 0) {
          setRecoveryPhase("grace");
          await new Promise((resolve) => setTimeout(resolve, graceMs));
        }
        if (generation !== recoveryGeneration || key !== activeTurnKey) { setRecoveryPhase(null); return; }
        if (Date.now() - lastActivityAt < threshold || hasUserDraft() || !activeTurn?.querySelector(STREAMING_SELECTOR)) {
          setRecoveryPhase(null);
          return;
        }
        // The ordinary heuristic always requires a second exact backend
        // confirmation immediately before intervention.
        setRecoveryPhase("checking");
        const secondStatus = await streamStatus(id);
        if (generation !== recoveryGeneration || key !== activeTurnKey) { setRecoveryPhase(null); return; }
        if (secondStatus !== "IS_STREAMING") {
          if (!stopButton() && secondStatus != null) {
            await recoverStall(id, key, generation, secondStatus);
            return;
          }
          setRecoveryPhase(null);
          scheduleStallCheck(30_000);
          return;
        }
        await recoverStall(id, key, generation, secondStatus);
        return;
      }

      if (!hasLongWaitBanner(activeTurn) || hasUserDraft()) { setRecoveryPhase(null); return; }
      await recoverStall(id, key, generation, hadStopControl ? null : firstStatus);
    } finally {
      stallCheckInFlight = false;
    }
  }

  function teardown() {
    clearTimer();
    clearCountdownUiTimer();
    clearDiscovery();
    clearBackgroundWakeup();
    disconnectCandidateObserver();
    disconnectShellObservers();
    if (activityObserver) activityObserver.disconnect();
    if (turnListObserver) turnListObserver.disconnect();
    activityObserver = null;
    turnListObserver = null;
    activeTurn = null;
    activeTurnKey = null;
    turnList = null;
    recoveryPhase = null;
    stallCheckInFlight = false;
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

    ext.runtime?.onMessage?.addListener((message) => {
      if (!message || message.type !== "cg-stall-alarm-fire") return undefined;
      backgroundWakeDueAt = null;
      // An alarm may be stale after activity/turn changes; checkForStall derives
      // everything from the current DOM + wall clock and safely ignores it.
      queueMicrotask(checkForStall);
      return undefined;
    });

    document.addEventListener("visibilitychange", onVisibilityChange, { passive: true });
    document.addEventListener("submit", onPotentialRunStart, true);
    document.addEventListener("click", onPotentialRunStart, true);
    document.addEventListener("keydown", onPotentialRunStart, true);
    if (settings.stallRecoveryEnabled) scheduleDiscovery();
  }

  globalThis.CGAntiCurseStallRecovery = {
    debug() {
      return {
        enabled: settings.stallRecoveryEnabled,
        conversationId: conversationId(),
        activeTurn: !!activeTurn,
        activeTurnKey,
        runningTool: runningTool(),
        longWaitBanner: hasLongWaitBanner(),
        recoveryPhase,
        countdownRemainingMs: recoveryRemainingMs(),
        stallCheckInFlight,
        backgroundWakeDueAt,
        lastActivityAt,
        attemptedTurnKey,
        attemptedTurnCount: attemptedTurns.size,
        timeoutSeconds: settings.stallRecoveryTimeoutSeconds,
        toolTimeoutSeconds: settings.stallRecoveryToolTimeoutSeconds,
        turnListObserver: !!turnListObserver,
        shellObserverCount: shellObservers.length,
        discoveryObserver: !!discoveryObserver,
        candidateObserver: !!candidateObserver,
        stopButton: !!stopButton(),
        visibilityState: document.visibilityState,
        latestTurnHasStreaming: !!latestTurnWrapper()?.querySelector(STREAMING_SELECTOR)
      };
    }
  };

  start();
})();
