/*
 * Controller for limited-history modes.
 *
 * Responsibilities:
 *   - locate ChatGPT's conversation scroll root;
 *   - detect when Auto windowed history reaches the top;
 *   - expose in-page and popup "Load previous N" controls;
 *   - pass the local visible-history archive to history-overlay.js.
 *
 * Rendering itself is intentionally kept in history-overlay.js so this file
 * never manipulates ChatGPT's React-owned conversation children.
 */
(() => {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const IS_FIREFOX = typeof browser !== "undefined";
  const CHANNEL = "__gpt_anticurse_v1__";
  const LIMITED_MODES = new Set(["recent", "latest-visible", "windowed-visible"]);
  const FIXED_WINDOW_MODES = new Set(["recent", "latest-visible"]);
  const DEFAULT_SETTINGS = {
    enabled: true,
    mode: "visible-history",
    maxDisplayMessages: 64
  };
  const TOP_EPSILON = 16;
  const REATTACH_INTERVAL_MS = 750;

  let settings = { ...DEFAULT_SETTINGS };
  let history = null;
  let nativeScroller = null;
  let nativeEventTarget = null;
  let rootStateObserver = null;
  let reattachTimer = null;
  let lastNativeTop = 0;
  let lastFromTop = null;
  let autoArmed = false;
  let suppressAutoUntil = 0;
  let topButtonHost = null;
  let topButton = null;

  const reader = CGHistoryOverlay.create({
    onClose: handleReaderClosed
  });

  function isLimitedMode(mode) {
    return LIMITED_MODES.has(mode);
  }

  function isFixedWindowMode(mode) {
    return FIXED_WINDOW_MODES.has(mode);
  }

  function firstNativeTurn() {
    return document.querySelector('[data-testid^="conversation-turn-"]') ||
      document.querySelector("[data-message-author-role]")?.closest("section, article, [data-turn-id-container]") ||
      null;
  }

  function findFallbackScroller(element) {
    let node = element && element.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 40) {
        return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function findNativeScroller() {
    // ChatGPT currently exposes exactly this marker on the conversation scroll
    // root. The ancestor fallback keeps the extension functional if it changes.
    const marked = document.querySelector("[data-scroll-root]");
    if (marked && (marked.querySelector('[data-testid^="conversation-turn-"]') || marked.querySelector("#thread"))) {
      return marked;
    }
    return findFallbackScroller(firstNativeTurn());
  }

  function nativeTop() {
    return nativeScroller ? Math.max(0, Number(nativeScroller.scrollTop) || 0) : 0;
  }

  function isAtNativeTop() {
    if (!nativeScroller) return false;
    // On current ChatGPT, data-scroll-from-top is present while the scroll
    // root is away from its top. Treat that as authoritative when present, with
    // scrollTop retained as a compatibility fallback for future DOM changes.
    if (nativeScroller.hasAttribute("data-scroll-from-top")) return false;
    return nativeTop() <= TOP_EPSILON;
  }

  function eventTargetForScroller(scroller) {
    return scroller === document.scrollingElement || scroller === document.documentElement
      ? window
      : scroller;
  }

  function previousPageCount() {
    if (!history || !Array.isArray(history.messages)) return 0;
    const nativeCount = Math.max(0, Number(history.nativeVisibleCount) || 0);
    const olderCount = Math.max(0, history.messages.length - nativeCount);
    const pageSize = Math.max(4, Math.min(500, Number(history.pageSize) || Number(settings.maxDisplayMessages) || 64));
    return Math.min(pageSize, olderCount);
  }

  function ensureTopButton() {
    if (topButtonHost && topButtonHost.isConnected) return;

    topButtonHost = document.createElement("div");
    topButtonHost.id = "cg-window-history-top-control";
    topButtonHost.style.cssText = "all:initial;position:fixed;z-index:2147483645;display:none;pointer-events:none;";
    document.documentElement.appendChild(topButtonHost);

    const shadow = topButtonHost.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        button {
          pointer-events: auto;
          border: 1px solid rgba(127,127,127,.32);
          border-radius: 999px;
          padding: 7px 11px;
          background: color-mix(in srgb, Canvas 92%, transparent);
          color: CanvasText;
          box-shadow: 0 2px 12px rgba(0,0,0,.16);
          backdrop-filter: blur(8px);
          font: 600 12px/1.2 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
          cursor: pointer;
        }
        button:hover { filter: brightness(1.08); }
      </style>
      <button type="button"></button>`;
    topButton = shadow.querySelector("button");
    topButton.addEventListener("click", () => {
      const result = manualOpen();
      if (result.ok) updateTopButton();
    });
  }

  function positionTopButton() {
    if (!topButtonHost || !nativeScroller) return;
    const rootRect = nativeScroller.getBoundingClientRect();
    const headerRect = document.querySelector("#page-header")?.getBoundingClientRect();
    const top = Math.max(rootRect.top + 8, headerRect && headerRect.bottom > rootRect.top ? headerRect.bottom + 8 : rootRect.top + 8);
    const left = rootRect.left + rootRect.width / 2;
    topButtonHost.style.top = `${Math.round(top)}px`;
    topButtonHost.style.left = `${Math.round(left)}px`;
    topButtonHost.style.transform = "translateX(-50%)";
  }

  function hideTopButton() {
    if (topButtonHost) topButtonHost.style.display = "none";
  }

  function updateTopButton() {
    const count = previousPageCount();
    const shouldShow = settings.enabled &&
      isFixedWindowMode(settings.mode) &&
      !!history &&
      count > 0 &&
      !reader.isOpen() &&
      isAtNativeTop();

    if (!shouldShow) {
      hideTopButton();
      return;
    }

    ensureTopButton();
    topButton.textContent = `Load previous ${count}`;
    topButton.setAttribute("aria-label", `Load previous ${count} conversation turns`);
    positionTopButton();
    topButtonHost.style.display = "block";
  }

  function detachNativeWatch() {
    if (rootStateObserver) rootStateObserver.disconnect();
    rootStateObserver = null;

    if (nativeEventTarget) {
      nativeEventTarget.removeEventListener("scroll", onNativeScroll, true);
    }
    nativeEventTarget = null;
    nativeScroller = null;
    lastFromTop = null;
    hideTopButton();
  }

  function handleTopReached() {
    if (!settings.enabled || !history || reader.isOpen()) return;

    if (settings.mode === "windowed-visible" &&
        performance.now() >= suppressAutoUntil &&
        autoArmed &&
        reader.hasOlderTurns()) {
      if (reader.open()) {
        hideTopButton();
        return;
      }
    }
    updateTopButton();
  }

  function onRootStateMutation() {
    if (!nativeScroller) return;
    const fromTop = nativeScroller.hasAttribute("data-scroll-from-top");
    if (lastFromTop === true && fromTop === false) {
      // ChatGPT itself just reported that its scroll root reached the top.
      handleTopReached();
    }
    lastFromTop = fromTop;
    if (fromTop) autoArmed = true;
    updateTopButton();
  }

  function attachNativeWatch() {
    if (!history || !settings.enabled || !isLimitedMode(settings.mode)) return false;

    const nextScroller = findNativeScroller();
    if (!nextScroller) return false;
    const nextTarget = eventTargetForScroller(nextScroller);

    if (nativeScroller === nextScroller && nativeScroller.isConnected && nativeEventTarget === nextTarget) {
      positionTopButton();
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
    rootStateObserver.observe(nativeScroller, {
      attributes: true,
      attributeFilter: ["data-scroll-from-top"]
    });

    updateTopButton();
    return true;
  }

  function refreshNativeWatch() {
    if (!history || !settings.enabled || !isLimitedMode(settings.mode)) {
      detachNativeWatch();
      return false;
    }

    const current = findNativeScroller();
    if (!nativeScroller || !nativeScroller.isConnected || current !== nativeScroller) {
      return attachNativeWatch();
    }
    updateTopButton();
    return true;
  }

  function startReattachWatch() {
    if (reattachTimer) return;
    refreshNativeWatch();
    reattachTimer = setInterval(refreshNativeWatch, REATTACH_INTERVAL_MS);
    window.addEventListener("resize", positionTopButton, { passive: true });
  }

  function stopReattachWatch() {
    if (reattachTimer) clearInterval(reattachTimer);
    reattachTimer = null;
    window.removeEventListener("resize", positionTopButton);
  }

  function onNativeScroll() {
    if (!nativeScroller || reader.isOpen()) return;

    const currentTop = nativeTop();
    const movingUp = currentTop < lastNativeTop - 0.5;
    if (currentTop > 64 || nativeScroller.hasAttribute("data-scroll-from-top")) autoArmed = true;

    if (movingUp && isAtNativeTop()) handleTopReached();
    else updateTopButton();
    lastNativeTop = currentTop;
  }

  function eventBelongsToConversation(event) {
    if (!nativeScroller) return false;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    return path.includes(nativeScroller) || (event.target instanceof Node && nativeScroller.contains(event.target));
  }

  function onGlobalWheel(event) {
    if (!settings.enabled || !history || !isLimitedMode(settings.mode) || reader.isOpen()) return;
    refreshNativeWatch();
    if (!nativeScroller || !eventBelongsToConversation(event)) return;

    // At the exact top another upward wheel gesture produces no scroll event.
    // This is a fallback for auto mode and also refreshes the fixed-mode button.
    if (event.deltaY < 0 && isAtNativeTop()) {
      if (settings.mode === "windowed-visible" &&
          performance.now() >= suppressAutoUntil &&
          reader.hasOlderTurns()) {
        autoArmed = true;
        if (reader.open() && event.cancelable) event.preventDefault();
      } else {
        updateTopButton();
      }
    }
  }

  function handleReaderClosed() {
    suppressAutoUntil = performance.now() + 700;
    autoArmed = false;
    refreshNativeWatch();
    if (nativeScroller) {
      nativeScroller.scrollTop = 0;
      lastNativeTop = 0;
    }
    updateTopButton();
  }

  function applyHistory(value) {
    history = value && Array.isArray(value.messages) ? value : null;
    reader.setHistory(history);

    if (!history || !settings.enabled || !isLimitedMode(settings.mode)) {
      detachNativeWatch();
      stopReattachWatch();
      return;
    }
    startReattachWatch();
  }

  function manualOpen() {
    if (!settings.enabled) return { ok: false, reason: "guard-disabled" };
    if (!isLimitedMode(settings.mode)) return { ok: false, reason: "mode-has-full-history" };
    if (!history) return { ok: false, reason: "no-history-archive" };
    if (!reader.hasOlderTurns()) return { ok: false, reason: "no-older-visible-turns" };
    return { ok: reader.open() };
  }

  function clear() {
    stopReattachWatch();
    detachNativeWatch();
    reader.destroy();
    history = null;
    if (topButtonHost) topButtonHost.remove();
    topButtonHost = null;
    topButton = null;
  }

  async function requestFirefoxHistory() {
    if (!IS_FIREFOX || !settings.enabled || !isLimitedMode(settings.mode)) return;
    try {
      applyHistory(await ext.runtime.sendMessage({ type: "cg-get-window-history" }));
    } catch (_) {}
  }

  window.addEventListener("wheel", onGlobalWheel, { passive: false, capture: true });

  ext.storage.local.get(DEFAULT_SETTINGS).then((saved) => {
    settings = { ...DEFAULT_SETTINGS, ...saved };
    requestFirefoxHistory();
  }).catch(() => {});

  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (changes[key]) settings[key] = changes[key].newValue;
    }

    if (!settings.enabled || !isLimitedMode(settings.mode)) {
      clear();
    } else if (IS_FIREFOX) {
      requestFirefoxHistory();
    } else if (history) {
      startReattachWatch();
      refreshNativeWatch();
    }
  });

  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "cg-open-window-history") {
      const result = manualOpen();
      if (IS_FIREFOX) return Promise.resolve(result);
      sendResponse(result);
      return false;
    }

    if (IS_FIREFOX && message && message.type === "cg-window-history") {
      applyHistory(message.history);
    }
    return undefined;
  });

  if (!IS_FIREFOX) {
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const message = event.data;
      if (message && message.channel === CHANNEL && message.type === "history") {
        applyHistory(message.history);
      }
    });
  }
})();
