/* Limited-history controller. Old turns stay outside ChatGPT's React-owned graph. */
(() => {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const extensionManifest = ext.runtime.getManifest();
  const IS_FIREFOX = !!(extensionManifest.browser_specific_settings && extensionManifest.browser_specific_settings.gecko);
  const PACKAGE_TARGET = IS_FIREFOX ? "firefox" : "chromium";
  const RUNTIME_BROWSER = /Firefox\//.test(String(navigator.userAgent || "")) ? "firefox" : "chromium";
  const NETWORK_ARCHIVE_EVENT = "__gpt_anticurse_archive_ready__";
  const STATS_EVENT = "__gpt_anticurse_stats_ready__";
  const DEFAULT_SETTINGS = Object.freeze({ enabled: true, mode: "recent", maxDisplayMessages: 64 });
  const TOP_EPSILON = 16;
  const HISTORY_WATCHDOG_MS = 2000;
  const HISTORY_RETRY_BASE_MS = 1000;
  const HISTORY_RETRY_MAX_MS = 30000;
  const DIAGNOSTICS = globalThis.CGAntiCurseDiagnostics;
  const scope = globalThis.CGConversationScope.create();

  let settings = { ...DEFAULT_SETTINGS };
  let history = null;
  let historyConversationId = null;
  let historyKey = "none";
  let nativeScroller = null;
  let nativeEventTarget = null;
  let rootStateObserver = null;
  let shellObserver = null;
  let shellRefreshRaf = 0;
  let historyWatchdog = 0;
  let lastNativeTop = 0;
  let lastFromTop = null;
  let autoArmed = false;
  let suppressAutoUntil = 0;
  let initialPositionSettled = false;
  let userInteracted = false;
  let historyRequest = null;
  let historyFailureStreak = 0;
  let historyRetryAt = 0;

  const reader = CGHistoryOverlay.create({ getScroller: () => nativeScroller });

  function recordIssue(code, error, extra) {
    if (DIAGNOSTICS && typeof DIAGNOSTICS.record === "function") return DIAGNOSTICS.record("history", code, error, extra);
    console.warn(`[GPT AntiCurse] history/${code}`, error, extra || "");
    return Promise.resolve(null);
  }

  function clearHistoryIssue() {
    if (DIAGNOSTICS && typeof DIAGNOSTICS.clear === "function") return DIAGNOSTICS.clear("history");
    return Promise.resolve(false);
  }

  function resetHistoryBackoff() {
    historyFailureStreak = 0;
    historyRetryAt = 0;
  }

  function noteHistoryFailure() {
    historyFailureStreak = Math.min(8, historyFailureStreak + 1);
    const delay = Math.min(HISTORY_RETRY_MAX_MS, HISTORY_RETRY_BASE_MS * (2 ** (historyFailureStreak - 1)));
    historyRetryAt = performance.now() + delay;
    return delay;
  }

  function normalizeLimit(value) {
    const number = Number(value);
    return Math.max(4, Math.min(500, Number.isFinite(number) ? number : 64));
  }

  function normalizeMode(value) {
    return value === "windowed-visible" ? "windowed-visible" : "recent";
  }

  function applySavedSettings(saved) {
    settings = {
      enabled: saved && typeof saved.enabled === "boolean" ? saved.enabled : true,
      mode: normalizeMode(saved && saved.mode),
      maxDisplayMessages: normalizeLimit(saved && saved.maxDisplayMessages)
    };
  }

  function rawVisibleWindowCount(messages, requestedLimit) {
    const limit = normalizeLimit(requestedLimit);
    if (!Array.isArray(messages) || !messages.length) return 0;
    const units = [];
    let unit = -1;
    let previousRole = null;
    for (const message of messages) {
      const role = message && message.role === "user" ? "user" : "assistant";
      if (role === "user" || previousRole !== "assistant") unit++;
      units.push(unit);
      previousRole = role;
    }
    const totalUnits = unit + 1;
    if (totalUnits <= limit) return messages.length;
    const cutoff = totalUnits - limit;
    const first = units.findIndex((value) => value >= cutoff);
    return first < 0 ? messages.length : messages.length - first;
  }

  function historyFromArchive(archive) {
    if (!archive || !archive.id || !Array.isArray(archive.messages)) return null;
    const pageSize = normalizeLimit(settings.maxDisplayMessages);
    const messages = archive.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      createTime: message.createTime == null ? null : message.createTime
    }));
    return {
      ok: true,
      conversationId: archive.id,
      messages,
      nativeVisibleCount: rawVisibleWindowCount(messages, pageSize),
      pageSize,
      maxRendered: Math.max(pageSize, Math.min(500, pageSize * 3)),
      source: "isolated-transient"
    };
  }

  function transientHistory(token) {
    if (IS_FIREFOX || !token || !token.id) return null;
    const bridge = globalThis.CGAntiCurseArchiveBridge;
    if (!bridge || typeof bridge.get !== "function") return null;
    return historyFromArchive(bridge.get(token.id));
  }

  function firstNativeTurn() {
    return document.querySelector('[data-testid^="conversation-turn-"]') ||
      document.querySelector("[data-message-author-role]")?.closest("section, article, [data-turn-id-container]") || null;
  }

  function findFallbackScroller(element) {
    let node = element && element.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 40) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function findNativeScroller() {
    const marked = document.querySelector("[data-scroll-root]");
    if (marked && (marked.querySelector('[data-testid^="conversation-turn-"]') || marked.querySelector("#thread"))) return marked;
    return findFallbackScroller(firstNativeTurn());
  }

  function nativeTop() {
    return nativeScroller ? Math.max(0, Number(nativeScroller.scrollTop) || 0) : 0;
  }

  function isAtTop(knownTop) {
    if (!nativeScroller) return false;
    if (nativeScroller.hasAttribute("data-scroll-from-top")) return false;
    const top = Number.isFinite(knownTop) ? knownTop : nativeTop();
    return top <= TOP_EPSILON;
  }

  function eventTargetForScroller(scroller) {
    return scroller === document.scrollingElement || scroller === document.documentElement ? window : scroller;
  }

  function markUserInteraction(event) {
    if (!initialPositionSettled && event && event.isTrusted) userInteracted = true;
  }

  function settleInitialPosition() {
    if (initialPositionSettled || userInteracted || !nativeScroller) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (initialPositionSettled || userInteracted || !nativeScroller || !nativeScroller.isConnected) return;
      if (nativeScroller.hasAttribute("data-scroll-from-end")) {
        nativeScroller.scrollTop = Math.max(0, nativeScroller.scrollHeight - nativeScroller.clientHeight);
        lastNativeTop = nativeTop();
        autoArmed = lastNativeTop > 64 || nativeScroller.hasAttribute("data-scroll-from-top");
      }
      initialPositionSettled = true;
    }));
  }

  function detachNativeWatch() {
    if (rootStateObserver) rootStateObserver.disconnect();
    rootStateObserver = null;
    if (nativeEventTarget) nativeEventTarget.removeEventListener("scroll", onNativeScroll, true);
    nativeEventTarget = null;
    nativeScroller = null;
    lastFromTop = null;
  }

  function stopShellObserver() {
    if (shellObserver) shellObserver.disconnect();
    shellObserver = null;
    if (shellRefreshRaf) cancelAnimationFrame(shellRefreshRaf);
    shellRefreshRaf = 0;
  }

  function clearHistoryState() {
    if (historyWatchdog) clearTimeout(historyWatchdog);
    historyWatchdog = 0;
    detachNativeWatch();
    stopShellObserver();
    reader.destroy();
    history = null;
    historyConversationId = null;
    historyKey = "none";
    historyRequest = null;
    lastNativeTop = 0;
    lastFromTop = null;
    autoArmed = false;
    suppressAutoUntil = 0;
    initialPositionSettled = false;
    userInteracted = false;
    resetHistoryBackoff();
  }

  function syncConversationScope() {
    if (!scope.sync()) return false;
    clearHistoryState();
    return true;
  }

  function historyMatchesCurrentConversation() {
    const id = scope.currentId();
    return !!history && !!id && historyConversationId === id;
  }

  function canAutoLoad() {
    return settings.mode === "windowed-visible" && settings.enabled && historyMatchesCurrentConversation() && reader.hasMoreOlderTurns() && performance.now() >= suppressAutoUntil;
  }

  function loadPreviousPage(auto = false) {
    if (syncConversationScope()) {
      requestHistory();
      return { ok: false, reason: "conversation-changed" };
    }
    if (!settings.enabled) return { ok: false, reason: "guard-disabled" };
    if (!historyMatchesCurrentConversation()) return { ok: false, reason: "no-history-archive" };
    if (!reader.hasMoreOlderTurns()) return { ok: false, reason: "no-older-visible-turns" };
    const result = reader.loadPreviousPage({ preserveScroll: true });
    if (result.ok && auto) {
      suppressAutoUntil = performance.now() + 180;
      autoArmed = false;
    }
    return result;
  }

  function handleTopReached() {
    if (!autoArmed || !canAutoLoad()) return false;
    return loadPreviousPage(true).ok;
  }

  function onRootStateMutation() {
    if (!nativeScroller) return;
    if (syncConversationScope()) {
      requestHistory();
      return;
    }
    const fromTop = nativeScroller.hasAttribute("data-scroll-from-top");
    if (lastFromTop === true && fromTop === false) handleTopReached();
    lastFromTop = fromTop;
    if (fromTop) autoArmed = true;
  }

  function attachNativeWatch() {
    if (syncConversationScope()) {
      requestHistory();
      return false;
    }
    if (!historyMatchesCurrentConversation() || !settings.enabled) return false;
    const nextScroller = findNativeScroller();
    if (!nextScroller) return false;
    const nextTarget = eventTargetForScroller(nextScroller);

    if (nativeScroller !== nextScroller || nativeEventTarget !== nextTarget || !nativeScroller.isConnected) {
      detachNativeWatch();
      nativeScroller = nextScroller;
      nativeEventTarget = nextTarget;
      lastNativeTop = nativeTop();
      lastFromTop = nativeScroller.hasAttribute("data-scroll-from-top");
      autoArmed = lastFromTop || lastNativeTop > 64;
      nextTarget.addEventListener("scroll", onNativeScroll, { passive: true, capture: true });
      rootStateObserver = new MutationObserver(onRootStateMutation);
      rootStateObserver.observe(nativeScroller, { attributes: true, attributeFilter: ["data-scroll-from-top"] });
    }

    reader.ensureAttached();
    settleInitialPosition();
    return true;
  }

  function scheduleShellRefresh() {
    if (shellRefreshRaf) return;
    shellRefreshRaf = requestAnimationFrame(() => {
      shellRefreshRaf = 0;
      attachNativeWatch();
    });
  }

  function installShellObserver() {
    if (shellObserver || !document.body) return;
    const root = document.querySelector("#main") || document.body;
    shellObserver = new MutationObserver(() => {
      if (syncConversationScope()) {
        requestHistory();
        return;
      }
      const thread = document.querySelector("#thread");
      const host = document.querySelector("#cg-window-history-host");
      const misplaced = !!thread && (!host || host.parentElement !== thread.parentElement || host.nextSibling !== thread);
      if (!nativeScroller || !nativeScroller.isConnected || misplaced) scheduleShellRefresh();
    });
    shellObserver.observe(root, { childList: true, subtree: true });
  }

  function onNativeScroll() {
    if (!nativeScroller) return;
    if (syncConversationScope()) {
      requestHistory();
      return;
    }
    const currentTop = nativeTop();
    const movingUp = currentTop < lastNativeTop - 0.5;
    if (currentTop > 64 || nativeScroller.hasAttribute("data-scroll-from-top")) autoArmed = true;
    if (movingUp && isAtTop(currentTop)) handleTopReached();
    lastNativeTop = currentTop;
  }

  function eventBelongsToConversation(event) {
    if (!nativeScroller) return false;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    return path.includes(nativeScroller) || (event.target instanceof Node && nativeScroller.contains(event.target));
  }

  function onGlobalWheel(event) {
    if (syncConversationScope()) {
      requestHistory();
      return;
    }
    if (!settings.enabled || !historyMatchesCurrentConversation() || settings.mode !== "windowed-visible") return;
    if (!nativeScroller || !nativeScroller.isConnected) attachNativeWatch();
    if (!nativeScroller || !eventBelongsToConversation(event)) return;
    if (event.deltaY < 0 && isAtTop() && reader.hasMoreOlderTurns()) {
      autoArmed = true;
      if (canAutoLoad() && loadPreviousPage(true).ok && event.cancelable) event.preventDefault();
    }
  }

  function textSignature(value) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${text.length}:${hash >>> 0}`;
  }

  function snapshotKey(value) {
    if (!value || !Array.isArray(value.messages)) return "none";
    const messages = value.messages;
    const first = messages[0] || {};
    const last = messages[messages.length - 1] || {};
    return [
      value.conversationId || "",
      messages.length,
      Number(value.nativeVisibleCount) || 0,
      Number(value.pageSize) || 0,
      first.id || "",
      first.role || "",
      last.id || "",
      last.role || "",
      textSignature(last.text)
    ].join("\u001f");
  }

  function applyHistory(value, token) {
    if (!scope.isCurrent(token) || !token.id || !value || !Array.isArray(value.messages)) return false;
    const replyId = typeof value.conversationId === "string" && value.conversationId ? value.conversationId : token.id;
    if (replyId !== token.id) {
      recordIssue("conversation-mismatch", "History reply belonged to a different conversation.", {
        requestedConversationId: token.id,
        replyConversationId: replyId
      });
      return false;
    }

    const nextHistory = value;
    const nextKey = snapshotKey({ ...nextHistory, conversationId: replyId });
    reader.setMode(settings.mode);
    resetHistoryBackoff();

    if (history && historyConversationId === replyId && historyKey === nextKey) {
      history = nextHistory;
      if (settings.enabled) attachNativeWatch();
      return true;
    }

    history = nextHistory;
    historyConversationId = replyId;
    historyKey = nextKey;
    initialPositionSettled = false;
    userInteracted = false;
    reader.setHistory(history);
    if (historyWatchdog) clearTimeout(historyWatchdog);
    historyWatchdog = 0;
    clearHistoryIssue();

    if (!settings.enabled) {
      detachNativeWatch();
      stopShellObserver();
      return true;
    }

    attachNativeWatch();
    installShellObserver();
    return true;
  }

  async function performHistoryRequest(token) {
    try {
      const value = await ext.runtime.sendMessage({
        type: "cg-get-window-history",
        conversationId: token.id,
        maxDisplayMessages: settings.maxDisplayMessages
      });
      if (!scope.isCurrent(token)) return false;

      resetHistoryBackoff();
      if (value && value.ok === false) {
        if (!["archive-not-found", "missing-conversation-id", "conversation-mismatch"].includes(value.reason)) {
          recordIssue(value.reason || "background-history-failed", value.error || value.reason || "History request failed");
        }
        return false;
      }
      return applyHistory(value, token);
    } catch (error) {
      if (!scope.isCurrent(token)) return false;
      const retryInMs = noteHistoryFailure();
      recordIssue("runtime-request-failed", error, { failureStreak: historyFailureStreak, retryInMs });
      return false;
    }
  }

  function requestHistory() {
    if (!settings.enabled) return Promise.resolve(false);
    syncConversationScope();
    const token = scope.snapshot();
    if (!token.id) return Promise.resolve(false);

    const transient = transientHistory(token);
    if (transient) return Promise.resolve(applyHistory(transient, token));

    if (historyRequest && scope.isCurrent(historyRequest.token)) return historyRequest.promise;
    if (performance.now() < historyRetryAt) return Promise.resolve(false);

    const request = { token, promise: null };
    request.promise = performHistoryRequest(token).finally(() => {
      if (historyRequest === request) historyRequest = null;
    });
    historyRequest = request;
    return request.promise;
  }

  function scheduleHistoryWatchdog(reason) {
    const token = scope.snapshot();
    if (history || !settings.enabled || !token.id) return;
    if (historyWatchdog) clearTimeout(historyWatchdog);
    historyWatchdog = setTimeout(() => {
      historyWatchdog = 0;
      if (scope.isCurrent(token) && !history && settings.enabled) {
        recordIssue("missing-after-trim", "Conversation trimming succeeded but no archived history reached the UI.", {
          conversationId: token.id,
          mode: settings.mode,
          limit: settings.maxDisplayMessages,
          trigger: reason || "trimmed-stats"
        });
      }
    }, HISTORY_WATCHDOG_MS);
  }

  globalThis.CGAntiCurseHistoryDebug = {
    debug() {
      return {
        packageTarget: PACKAGE_TARGET,
        runtimeBrowser: RUNTIME_BROWSER,
        conversationId: scope.currentId(),
        historyConversationId,
        historyPresent: !!history,
        historySource: history && history.source ? history.source : null,
        requestInFlight: !!historyRequest,
        failureStreak: historyFailureStreak,
        retryInMs: historyRetryAt > performance.now() ? Math.ceil(historyRetryAt - performance.now()) : 0
      };
    }
  };

  window.addEventListener("wheel", onGlobalWheel, { passive: false, capture: true });
  window.addEventListener("wheel", markUserInteraction, { passive: true, capture: true });
  window.addEventListener("pointerdown", markUserInteraction, { passive: true, capture: true });
  window.addEventListener("touchstart", markUserInteraction, { passive: true, capture: true });
  window.addEventListener("keydown", markUserInteraction, { capture: true });
  window.addEventListener(NETWORK_ARCHIVE_EVENT, () => {
    if (IS_FIREFOX) return;
    requestHistory().then((ok) => {
      if (!ok && performance.now() >= historyRetryAt) {
        recordIssue("transient-archive-unavailable", "The MAIN-world archive event fired, but the isolated archive was unavailable.");
      }
    });
  });
  window.addEventListener(STATS_EVENT, (event) => {
    if (event && event.detail && event.detail.mode === "trimmed") scheduleHistoryWatchdog("trimmed-stats");
  });

  ext.storage.local.get(DEFAULT_SETTINGS).then((saved) => {
    applySavedSettings(saved);
    reader.setMode(settings.mode);
    return requestHistory();
  }).catch((error) => {
    applySavedSettings(DEFAULT_SETTINGS);
    reader.setMode(settings.mode);
    recordIssue("settings-read-failed", error);
    return requestHistory();
  });

  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const settingsChanged = !!(changes.enabled || changes.mode || changes.maxDisplayMessages);
    if (!settingsChanged) return;

    const next = { ...settings };
    if (changes.enabled) next.enabled = changes.enabled.newValue;
    if (changes.mode) next.mode = changes.mode.newValue;
    if (changes.maxDisplayMessages) next.maxDisplayMessages = changes.maxDisplayMessages.newValue;
    applySavedSettings(next);
    reader.setMode(settings.mode);
    resetHistoryBackoff();
    if (!settings.enabled) clearHistoryState();
    else requestHistory();
  });

  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "cg-open-window-history") {
      const result = loadPreviousPage(false);
      if (IS_FIREFOX) return Promise.resolve(result);
      sendResponse(result);
      return false;
    }
    if (IS_FIREFOX && message && message.type === "cg-window-history" && message.history) {
      const token = scope.snapshot();
      if (message.history.conversationId === token.id) applyHistory(message.history, token);
    }
    return undefined;
  });
})();