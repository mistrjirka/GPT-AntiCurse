/* Controller for limited-history modes. Older archived turns render inline above ChatGPT's native #thread. */
(() => {
  "use strict";
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const IS_FIREFOX = typeof browser !== "undefined";
  const CHANNEL = "__gpt_anticurse_v1__";
  const LIMITED_MODES = new Set(["recent", "latest-visible", "windowed-visible"]);
  const DEFAULT_SETTINGS = { enabled: true, mode: "recent", maxDisplayMessages: 64 };
  const TOP_EPSILON = 16;
  const REATTACH_INTERVAL_MS = 750;
  let settings = { ...DEFAULT_SETTINGS };
  let history = null;
  let historyKey = "none";
  let nativeScroller = null;
  let nativeEventTarget = null;
  let rootStateObserver = null;
  let reattachTimer = null;
  let lastNativeTop = 0;
  let lastFromTop = null;
  let autoArmed = false;
  let suppressAutoUntil = 0;
  const reader = CGHistoryOverlay.create({ getScroller: () => nativeScroller });

  function isLimitedMode(mode) { return LIMITED_MODES.has(mode); }
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
  function nativeTop() { return nativeScroller ? Math.max(0, Number(nativeScroller.scrollTop) || 0) : 0; }
  function isAtTop() {
    if (!nativeScroller) return false;
    if (nativeScroller.hasAttribute("data-scroll-from-top")) return false;
    return nativeTop() <= TOP_EPSILON;
  }
  function eventTargetForScroller(scroller) {
    return scroller === document.scrollingElement || scroller === document.documentElement ? window : scroller;
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
    return settings.mode === "windowed-visible" && settings.enabled && !!history &&
      reader.hasMoreOlderTurns() && performance.now() >= suppressAutoUntil;
  }
  function loadPreviousPage(auto = false) {
    if (!settings.enabled) return { ok: false, reason: "guard-disabled" };
    if (!isLimitedMode(settings.mode)) return { ok: false, reason: "mode-has-full-history" };
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
    if (!history || !settings.enabled || !isLimitedMode(settings.mode)) return false;
    const nextScroller = findNativeScroller();
    if (!nextScroller) return false;
    const nextTarget = eventTargetForScroller(nextScroller);
    if (nativeScroller === nextScroller && nativeScroller.isConnected && nativeEventTarget === nextTarget) {
      reader.ensureAttached();
      return true;
    }
    detachNativeWatch();
    nativeScroller = nextScroller;
    nativeEventTarget = nextTarget;
    lastNativeTop = nativeTop();
    lastFromTop = nativeScroller.hasAttribute("data-scroll-from-top");
    autoArmed = lastFromTop || lastNativeTop > 64;
    nextTarget.addEventListener("scroll", onNativeScroll, { passive: true, capture: true });
    rootStateObserver = new MutationObserver(onRootStateMutation);
    rootStateObserver.observe(nativeScroller, { attributes: true, attributeFilter: ["data-scroll-from-top"] });
    reader.ensureAttached();
    return true;
  }
  function refreshNativeWatch() {
    if (!history || !settings.enabled || !isLimitedMode(settings.mode)) {
      detachNativeWatch();
      return false;
    }
    const current = findNativeScroller();
    if (!nativeScroller || !nativeScroller.isConnected || current !== nativeScroller) return attachNativeWatch();
    reader.ensureAttached();
    return true;
  }
  function startReattachWatch() {
    if (reattachTimer) return;
    refreshNativeWatch();
    reattachTimer = setInterval(refreshNativeWatch, REATTACH_INTERVAL_MS);
  }
  function stopReattachWatch() {
    if (reattachTimer) clearInterval(reattachTimer);
    reattachTimer = null;
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
    refreshNativeWatch();
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
    return [
      messages.length,
      Number(value.nativeVisibleCount) || 0,
      Number(value.pageSize) || 0,
      first.id || "",
      first.role || "",
      last.id || "",
      last.role || "",
      String(last.text || "")
    ].join("\u001f");
  }
  function applyHistory(value) {
    const nextHistory = value && Array.isArray(value.messages) ? value : null;
    const nextKey = snapshotKey(nextHistory);
    reader.setMode(settings.mode);

    // Chromium may receive both the original publication and a retained replay;
    // Firefox may answer a settings-triggered history request with the same
    // snapshot. Equivalent snapshots must be idempotent: resetting the reader
    // here would erase pages the user already loaded.
    if (history && nextHistory && historyKey === nextKey) {
      history = nextHistory;
      if (settings.enabled && isLimitedMode(settings.mode)) {
        startReattachWatch();
        refreshNativeWatch();
      }
      return;
    }

    history = nextHistory;
    historyKey = nextKey;
    reader.setHistory(history);
    if (!history || !settings.enabled || !isLimitedMode(settings.mode)) {
      detachNativeWatch();
      stopReattachWatch();
      return;
    }
    startReattachWatch();
  }
  function clear() {
    stopReattachWatch();
    detachNativeWatch();
    reader.destroy();
    history = null;
    historyKey = "none";
  }
  async function requestFirefoxHistory() {
    if (!IS_FIREFOX || !settings.enabled || !isLimitedMode(settings.mode)) return;
    try { applyHistory(await ext.runtime.sendMessage({ type: "cg-get-window-history" })); } catch (_) {}
  }
  window.addEventListener("wheel", onGlobalWheel, { passive: false, capture: true });
  ext.storage.local.get(DEFAULT_SETTINGS).then((saved) => {
    settings = { ...DEFAULT_SETTINGS, ...saved };
    reader.setMode(settings.mode);
    requestFirefoxHistory();
  }).catch(() => {});
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of Object.keys(DEFAULT_SETTINGS)) if (changes[key]) settings[key] = changes[key].newValue;
    reader.setMode(settings.mode);
    if (!settings.enabled || !isLimitedMode(settings.mode)) clear();
    else if (IS_FIREFOX) requestFirefoxHistory();
    else if (history) { startReattachWatch(); refreshNativeWatch(); }
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
  if (!IS_FIREFOX) {
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const message = event.data;
      if (message && message.channel === CHANNEL && message.type === "history") applyHistory(message.history);
    });
  }
})();
