"use strict";

// Experimental virtualized reader for older *visible* turns. The newest turns stay in
// ChatGPT's native UI; this script renders older visible turns on demand without restoring
// hidden/tool/system nodes to ChatGPT's conversation graph.
(() => {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const IS_FIREFOX = typeof browser !== "undefined";
  const CHANNEL = "__gpt_anticurse_v1__";
  const DEFAULT_SETTINGS = { enabled: true, mode: "visible-history", maxDisplayMessages: 32 };

  let settings = { ...DEFAULT_SETTINGS };
  let history = null;
  let root = null;
  let list = null;
  let marker = null;
  let scroller = null;
  let scrollTarget = null;
  let loadedStart = 0;
  let loadedEnd = 0;
  let nativeStart = 0;
  let scrollScheduled = false;
  let attachObserver = null;

  function firstNativeTurn() {
    return document.querySelector('article[data-testid^="conversation-turn-"]') ||
      document.querySelector('[data-message-author-role]')?.closest("article") || null;
  }

  function findScroller(element) {
    let node = element && element.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 40) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function viewportEdges() {
    if (!scroller || scroller === document.scrollingElement || scroller === document.documentElement) {
      return { top: 0, bottom: window.innerHeight, height: window.innerHeight };
    }
    const rect = scroller.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: rect.height };
  }

  function preserveAnchor(anchor, oldTop) {
    if (!anchor || !anchor.isConnected || !scroller || !Number.isFinite(oldTop)) return;
    requestAnimationFrame(() => {
      if (!anchor.isConnected || !scroller) return;
      const delta = anchor.getBoundingClientRect().top - oldTop;
      if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
    });
  }

  function clear() {
    if (attachObserver) { attachObserver.disconnect(); attachObserver = null; }
    if (scrollTarget) scrollTarget.removeEventListener("scroll", onScroll);
    scrollTarget = scroller = null;
    if (root) root.remove();
    root = list = marker = null;
    loadedStart = loadedEnd = nativeStart = 0;
  }

  function updateMarker() {
    if (!marker || !history) return;
    if (nativeStart <= 0) {
      marker.textContent = "AntiCurse · no older visible turns";
      return;
    }
    const count = Math.max(0, loadedEnd - loadedStart);
    if (!count) {
      marker.textContent = `AntiCurse · ${nativeStart.toLocaleString()} older visible turns available · scroll up to load`;
      return;
    }
    const range = `${(loadedStart + 1).toLocaleString()}–${loadedEnd.toLocaleString()} / ${nativeStart.toLocaleString()}`;
    const directions = [];
    if (loadedStart > 0) directions.push("↑ older");
    if (loadedEnd < nativeStart) directions.push("↓ newer");
    marker.textContent = `AntiCurse · virtual visible history ${range}${directions.length ? ` · ${directions.join(" · ")}` : " · complete"}`;
  }

  function makeTurn(message) {
    const turn = document.createElement("article");
    turn.className = `cg-history-turn cg-history-${message.role === "user" ? "user" : "assistant"}`;
    turn.dataset.cgHistoryId = message.id || "";

    const head = document.createElement("div");
    head.className = "cg-history-head";
    head.textContent = message.role === "user" ? "You" : "Assistant";

    const body = document.createElement("div");
    body.className = "cg-history-body";
    body.textContent = message.text || "[Non-text visible message]";
    turn.append(head, body);
    return turn;
  }

  function attach() {
    if (!history || !settings.enabled || settings.mode !== "windowed-visible") return false;
    const nativeTurn = firstNativeTurn();
    if (!nativeTurn || !nativeTurn.parentElement) return false;
    if (root && root.isConnected && root.parentElement === nativeTurn.parentElement) return true;

    clear();
    const messages = Array.isArray(history.messages) ? history.messages : [];
    const nativeCount = Math.max(0, Number(history.nativeVisibleCount) || 0);
    nativeStart = Math.max(0, messages.length - nativeCount);
    loadedStart = loadedEnd = nativeStart;
    if (nativeStart <= 0) return true;

    root = document.createElement("section");
    root.id = "cg-windowed-history";
    root.setAttribute("aria-label", "Older visible messages loaded by GPT AntiCurse");
    marker = document.createElement("div");
    marker.className = "cg-history-marker";
    list = document.createElement("div");
    list.className = "cg-history-list";
    root.append(marker, list);
    nativeTurn.parentElement.insertBefore(root, nativeTurn);
    updateMarker();

    scroller = findScroller(nativeTurn);
    scrollTarget = (scroller === document.scrollingElement || scroller === document.documentElement) ? window : scroller;
    scrollTarget.addEventListener("scroll", onScroll, { passive: true });
    queueCheck();
    return true;
  }

  function ensureAttached() {
    if (!history || settings.mode !== "windowed-visible" || !settings.enabled) return;
    if (attach()) return;
    if (!attachObserver && document.documentElement) {
      attachObserver = new MutationObserver(() => {
        if (attach()) {
          attachObserver.disconnect();
          attachObserver = null;
        }
      });
      attachObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  function maxRendered() {
    return Math.max(32, Number(history && history.maxRendered) || 96);
  }

  function batchSize() {
    return Math.max(4, Number(history && history.batchSize) || 16);
  }

  function loadOlder() {
    if (!history || !list || !scroller || loadedStart <= 0) return false;
    const nextStart = Math.max(0, loadedStart - batchSize());
    const anchor = list.firstElementChild || firstNativeTurn();
    const oldTop = anchor ? anchor.getBoundingClientRect().top : NaN;
    const fragment = document.createDocumentFragment();
    for (const message of history.messages.slice(nextStart, loadedStart)) fragment.appendChild(makeTurn(message));
    list.insertBefore(fragment, list.firstChild);
    loadedStart = nextStart;

    let excess = (loadedEnd - loadedStart) - maxRendered();
    while (excess > 0 && list.lastElementChild) {
      list.lastElementChild.remove();
      loadedEnd--;
      excess--;
    }
    updateMarker();
    preserveAnchor(anchor, oldTop);
    return true;
  }

  function loadNewer() {
    if (!history || !list || !scroller || loadedEnd >= nativeStart) return false;
    const nextEnd = Math.min(nativeStart, loadedEnd + batchSize());
    const anchor = list.lastElementChild || firstNativeTurn();
    const oldTop = anchor ? anchor.getBoundingClientRect().top : NaN;
    const fragment = document.createDocumentFragment();
    for (const message of history.messages.slice(loadedEnd, nextEnd)) fragment.appendChild(makeTurn(message));
    list.appendChild(fragment);
    loadedEnd = nextEnd;

    let excess = (loadedEnd - loadedStart) - maxRendered();
    while (excess > 0 && list.firstElementChild) {
      list.firstElementChild.remove();
      loadedStart++;
      excess--;
    }
    updateMarker();
    preserveAnchor(anchor, oldTop);
    return true;
  }

  function check() {
    scrollScheduled = false;
    if (!history || !root || !scroller || settings.mode !== "windowed-visible") return;
    const edges = viewportEdges();
    const rect = root.getBoundingClientRect();
    const threshold = Math.max(280, Math.min(700, edges.height * 0.65));

    if (loadedStart > 0 && rect.top >= edges.top - threshold) {
      loadOlder();
      return;
    }
    if (loadedEnd < nativeStart && rect.bottom <= edges.bottom + threshold) {
      loadNewer();
    }
  }

  function queueCheck() {
    if (scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(check);
  }

  function onScroll() { queueCheck(); }

  function applyHistory(value) {
    history = value && Array.isArray(value.messages) ? value : null;
    if (!history) clear();
    else ensureAttached();
  }

  ext.storage.local.get(DEFAULT_SETTINGS).then((saved) => {
    settings = { ...DEFAULT_SETTINGS, ...saved };
    if (IS_FIREFOX && settings.mode === "windowed-visible" && settings.enabled) {
      ext.runtime.sendMessage({ type: "cg-get-window-history" }).then(applyHistory).catch(() => {});
    } else if (history) {
      ensureAttached();
    }
  }).catch(() => {});

  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of Object.keys(DEFAULT_SETTINGS)) if (changes[key]) settings[key] = changes[key].newValue;
    if (!settings.enabled || settings.mode !== "windowed-visible") {
      clear();
    } else if (IS_FIREFOX) {
      ext.runtime.sendMessage({ type: "cg-get-window-history" }).then(applyHistory).catch(() => {});
    } else {
      ensureAttached();
    }
  });

  if (IS_FIREFOX) {
    ext.runtime.onMessage.addListener((message) => {
      if (message && message.type === "cg-window-history") applyHistory(message.history);
    });
  } else {
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const msg = event.data;
      if (msg && msg.channel === CHANNEL && msg.type === "history") applyHistory(msg.history);
    });
  }
})();
