/* Limited-history controller. Old turns stay outside ChatGPT's React-owned graph. */
(() => {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  // Chrome 148+ also exposes `browser`, so namespace presence is not browser identity.
  // This code runs in a page-backed content-script realm where the browser UA is a
  // direct, synchronous description of the actual host browser.
  const IS_FIREFOX = /Firefox\//.test(String(navigator.userAgent || ""));
  const NETWORK_ARCHIVE_EVENT = "__gpt_anticurse_archive_ready__";
  const STATS_EVENT = "__gpt_anticurse_stats_ready__";
  const DEFAULT_SETTINGS = Object.freeze({ enabled: true, mode: "recent", maxDisplayMessages: 64 });
  const TOP_EPSILON = 16;
  const HISTORY_WATCHDOG_MS = 2000;
  const HISTORY_RETRY_BASE_MS = 1000;
  const HISTORY_RETRY_MAX_MS = 30000;
  const DIAGNOSTICS = globalThis.CGAntiCurseDiagnostics;

  let settings = { ...DEFAULT_SETTINGS };
  let history = null;
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
  let historyRequestPromise = null;
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

  function conversationId() {
    if (globalThis.CGArchive && typeof CGArchive.conversationIdFromUrl === "function") return CGArchive.conversationIdFromUrl(location.href);
    const match = location.pathname.match(/(?:^|\/)c\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
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
    if (!archive || !Array.isArray(archive.messages)) return null;
    const pageSize = normalizeLimit(settings.maxDisplayMessages);
    const messages = archive.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      createTime: message.createTime == null ? null : message.createTime
    }));
    return {
      ok: true,
      messages,
      nativeVisibleCount: rawVisibleWindowCount(messages, pageSize),
      pageSize,
      maxRendered: Math.max(pageSize, Math.min(500, pageSize * 3)),
      source: "isolated-transient"
    };
  }

  function transientHistory() {
    if (IS_FIREFOX) return null;
    const bridge = globalThis.CGAntiCurseArchiveBridge;
    const id = conversationId();
    if (!bridge || typeof bridge.get !== "function" || !id) return null;
    return historyFromArchive(bridge.get(id));
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

  function isAtTop() {
    if (!nativeScroller) return false;
    if (nativeScroller.hasAttribute("data-scroll-from-top")) return false;
    return nativeTop() <= TOP_EPSILON;
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

  function canAutoLoad() {
    return settings.mode === "windowed-visible" && settings.enabled && !!history && reader.hasMoreOlderTurns() && performance.now() >= suppressAutoUntil;
  }

  function loadPreviousPage(auto = false) {
    if (!settings.enabled) return { ok: false, reason: "guard-disabled" };
    if (!history) return { ok: false, reason: "no-history-archive" };
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
    const fromTop = nativeScroller.hasAttribute("data-scroll-from-top");
    if (lastFromTop === true && fromTop === false) handleTopReached();
    lastFromTop = fromTop;
    if (fromTop) autoArmed = true;
  }

  function attachNativeWatch() {
    if (!history || !settings.enabled) return false;
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
      const thread = document.querySelector("#thread");
      const host = document.querySelector("#cg-window-history-host");
      const misplaced = !!thread && (!host || host.parentElement !== thread.parentElement || host.nextSibling !== thread);
      if (!nativeScroller || !nativeScroller.isConnected || misplaced) scheduleShellRefresh();
    });
    shellObserver.observe(root, { childList: true, subtree: true });
  }

  function stopShellObserver() {
    if (shellObserver) shellObserver.disconnect();
    shellObserver = null;
    if (shellRefreshRaf) cancelAnimationFrame(shellRefreshRaf);
    shellRefreshRaf = 0;
  }

  function onNativeScroll() {
    if (!nativeScroller) return;
    const currentTop = nativeTop();
    const movingUp = currentTop < lastNativeTop - 0.5;
    if (currentTop > 64 || nativeScroller.hasAttribute("data-scroll-from-top")) autoArmed = true;
    if (movingUp && isAtTop()) handleTopReached();
    lastNativeTop = currentTop;
  }

  function eventBelongsToConversation(event) {
    if (!nativeScroller) return false;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    return path.includes(nativeScroller) || (event.target instanceof Node && nativeScroller.contains(event.target));
  }

  function onGlobalWheel(event) {
    if (!settings.enabled || !history || settings.mode !== "windowed-visible") return;
    if (!nativeScroller || !nativeScroller.isConnected) attachNativeWatch();
    if (!nativeScroller || !eventBelongsToConversation(event)) return;
    if (event.deltaY < 0 && isAtTop() && reader.hasMoreOlderTurns()) {
      autoArmed = true;
      if (canAutoLoad() && loadPreviousPage(true).ok && event.cancelable) event.preventDefault();
    }
  }

  function snapshotKey(value) {
    if (!value || !Array.isArray(value.messages)) return "none";
    const messages = value.messages;
    const first = messages[0] || {};
    const last = messages[messages.length - 1] || {};
    return [messages.length, Number(value.nativeVisibleCount) || 0, Number(value.pageSize) || 0,
      first.id || "", first.role || "", last.id || "", last.role || "", String(last.text || "")].join("\u001f");
  }

  function applyHistory(value) {
    const nextHistory = value && Array.isArray(value.messages) ? value : null;
    const nextKey = snapshotKey(nextHistory);
    reader.setMode(settings.mode);
    if (!nextHistory) return false;

    resetHistoryBackoff();
    if (history && historyKey === nextKey) {
      history = nextHistory;
      if (settings.enabled) attachNativeWatch();
      return true;
    }

    history = nextHistory;
    historyKey = nextKey;
    initialPositionSettled = false;
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

  function clear() {
    if (historyWatchdog) clearTimeout(historyWatchdog);
    historyWatchdog = 0;
    detachNativeWatch();
    stopShellObserver();
    reader.destroy();
    history = null;
    historyKey = "none";
    initialPositionSettled = false;
    historyRequestPromise = null;
    resetHistoryBackoff();
  }

  async function performHistoryRequest() {
    const id = conversationId();
    if (!IS_FIREFOX && !id) return false;

    try {
      const value = await ext.runtime.sendMessage({
        type: "cg-get-window-history",
        conversationId: id,
        maxDisplayMessages: settings.maxDisplayMessages
      });
      // Any response means the receiver is alive. Archive-not-found is not a
      // transport failure and therefore must not keep the retry cooldown active.
      resetHistoryBackoff();
      if (value && value.ok === false) {
        if (value.reason !== "archive-not-found" && value.reason !== "missing-conversation-id") {
          recordIssue(value.reason || "background-history-failed", value.error || value.reason || "History request failed");
        }
        return false;
      }
      if (!value || !Array.isArray(value.messages)) return false;
      return applyHistory(value);
    } catch (error) {
      const retryInMs = noteHistoryFailure();
      recordIssue("runtime-request-failed", error, { failureStreak: historyFailureStreak, retryInMs });
      return false;
    }
  }

  function requestHistory() {
    if (!settings.enabled) return Promise.resolve(false);

    const transient = transientHistory();
    if (transient) return Promise.resolve(applyHistory(transient));

    if (historyRequestPromise) return historyRequestPromise;
    if (performance.now() < historyRetryAt) return Promise.resolve(false);

    historyRequestPromise = performHistoryRequest().finally(() => {
      historyRequestPromise = null;
    });
    return historyRequestPromise;
  }

  function scheduleHistoryWatchdog(reason) {
    if (history || !settings.enabled || !conversationId()) return;
    if (historyWatchdog) clearTimeout(historyWatchdog);
    historyWatchdog = setTimeout(() => {
      historyWatchdog = 0;
      if (!history && settings.enabled && conversationId()) {
        recordIssue("missing-after-trim", "Conversation trimming succeeded but no archived history reached the UI.", {
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
        browserPath: IS_FIREFOX ? "firefox" : "chromium",
        historyPresent: !!history,
        historySource: history && history.source ? history.source : null,
        requestInFlight: !!historyRequestPromise,
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
    // Diagnostics, counters, and archive bookkeeping also write storage.local.
    // Reacting to those writes here creates a request -> diagnostic -> storage
    // feedback loop when the background receiver is unavailable.
    if (!settingsChanged) return;

    const next = { ...settings };
    if (changes.enabled) next.enabled = changes.enabled.newValue;
    if (changes.mode) next.mode = changes.mode.newValue;
    if (changes.maxDisplayMessages) next.maxDisplayMessages = changes.maxDisplayMessages.newValue;
    applySavedSettings(next);
    reader.setMode(settings.mode);
    resetHistoryBackoff();
    if (!settings.enabled) clear();
    else requestHistory();
  });

  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "cg-open-window-history") {
      const result = loadPreviousPage(false);
      if (IS_FIREFOX) return Promise.resolve(result);
      sendResponse(result);
      return false;
    }
    if (IS_FIREFOX && message && message.type === "cg-window-history") applyHistory(message.history);
    return undefined;
  });
})();
