/*
 * Controller for limited-history modes.
 *
 * Responsibilities:
 *   - locate ChatGPT's actual scroll root;
 *   - detect when Auto windowed history reaches the top;
 *   - expose the manual "Load previous N" fallback;
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
  const DEFAULT_SETTINGS = {
    enabled: true,
    mode: "visible-history",
    maxDisplayMessages: 32
  };

  let settings = { ...DEFAULT_SETTINGS };
  let history = null;
  let nativeScroller = null;
  let nativeEventTarget = null;
  let attachObserver = null;
  let lastNativeTop = 0;
  let autoArmed = false;
  let suppressAutoUntil = 0;

  const reader = CGHistoryOverlay.create({
    onClose: handleReaderClosed
  });

  function isLimitedMode(mode) {
    return LIMITED_MODES.has(mode);
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
    // ChatGPT currently marks the conversation scroller with data-scroll-root.
    // The fallback keeps the extension functional if that marker changes.
    return document.querySelector("[data-scroll-root]") || findFallbackScroller(firstNativeTurn());
  }

  function nativeTop() {
    return nativeScroller ? Math.max(0, Number(nativeScroller.scrollTop) || 0) : 0;
  }

  function eventTargetForScroller(scroller) {
    return scroller === document.scrollingElement || scroller === document.documentElement
      ? window
      : scroller;
  }

  function detachNativeWatch() {
    if (nativeEventTarget) {
      nativeEventTarget.removeEventListener("wheel", onNativeWheel, true);
      nativeEventTarget.removeEventListener("scroll", onNativeScroll, true);
    }
    nativeEventTarget = null;
    nativeScroller = null;
  }

  function attachNativeWatch() {
    if (!history || !settings.enabled || !isLimitedMode(settings.mode)) return false;

    const nextScroller = findNativeScroller();
    if (!nextScroller) return false;

    const nextTarget = eventTargetForScroller(nextScroller);
    if (nativeScroller === nextScroller && nativeEventTarget === nextTarget) return true;

    detachNativeWatch();
    nativeScroller = nextScroller;
    nativeEventTarget = nextTarget;
    lastNativeTop = nativeTop();
    autoArmed = lastNativeTop > 64;

    nextTarget.addEventListener("wheel", onNativeWheel, { passive: false, capture: true });
    nextTarget.addEventListener("scroll", onNativeScroll, { passive: true, capture: true });
    return true;
  }

  function ensureNativeWatch() {
    if (attachNativeWatch() || attachObserver || !document.documentElement) return;

    attachObserver = new MutationObserver(() => {
      if (attachNativeWatch()) {
        attachObserver.disconnect();
        attachObserver = null;
      }
    });
    attachObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function shouldAutoOpen(currentTop, movingUp) {
    return settings.mode === "windowed-visible" &&
      settings.enabled &&
      history &&
      !reader.isOpen() &&
      movingUp &&
      currentTop <= 10 &&
      performance.now() >= suppressAutoUntil;
  }

  function onNativeScroll() {
    if (!nativeScroller || reader.isOpen()) return;

    const currentTop = nativeTop();
    if (currentTop > 64) autoArmed = true;
    const movingUp = currentTop < lastNativeTop - 0.5;

    if (autoArmed && shouldAutoOpen(currentTop, movingUp)) reader.open();
    lastNativeTop = currentTop;
  }

  function onNativeWheel(event) {
    if (reader.isOpen() || settings.mode !== "windowed-visible" || !history || !settings.enabled) return;

    // When scrollTop is already zero, another upward wheel gesture produces no
    // scroll event. Catch that gesture explicitly so Auto mode still opens.
    if (event.deltaY < 0 && nativeTop() <= 12 && performance.now() >= suppressAutoUntil) {
      if (reader.open()) event.preventDefault();
    }
  }

  function handleReaderClosed() {
    suppressAutoUntil = performance.now() + 700;
    autoArmed = false;
    if (nativeScroller) {
      nativeScroller.scrollTop = 0;
      lastNativeTop = 0;
    }
  }

  function applyHistory(value) {
    history = value && Array.isArray(value.messages) ? value : null;
    reader.setHistory(history);

    if (!history || !settings.enabled || !isLimitedMode(settings.mode)) {
      detachNativeWatch();
      return;
    }
    ensureNativeWatch();
  }

  function manualOpen() {
    if (!settings.enabled) return { ok: false, reason: "guard-disabled" };
    if (!isLimitedMode(settings.mode)) return { ok: false, reason: "mode-has-full-history" };
    if (!history) return { ok: false, reason: "no-history-archive" };
    if (!reader.hasOlderTurns()) return { ok: false, reason: "no-older-visible-turns" };
    return { ok: reader.open() };
  }

  function clear() {
    if (attachObserver) {
      attachObserver.disconnect();
      attachObserver = null;
    }
    detachNativeWatch();
    reader.destroy();
    history = null;
  }

  async function requestFirefoxHistory() {
    if (!IS_FIREFOX || !settings.enabled || !isLimitedMode(settings.mode)) return;
    try {
      applyHistory(await ext.runtime.sendMessage({ type: "cg-get-window-history" }));
    } catch (_) {}
  }

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
      ensureNativeWatch();
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
