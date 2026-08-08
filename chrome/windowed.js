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

  function top() { return scroller ? scroller.scrollTop : 0; }
  function height() { return scroller ? scroller.scrollHeight : 0; }
  function viewport() {
    return !scroller || scroller === document.scrollingElement || scroller === document.documentElement
      ? window.innerHeight
      : scroller.clientHeight;
  }
  function setTop(value) { if (scroller) scroller.scrollTop = Math.max(0, value); }

  function clear() {
    if (attachObserver) { attachObserver.disconnect(); attachObserver = null; }
    if (scrollTarget) scrollTarget.removeEventListener("scroll", onScroll);
    scrollTarget = scroller = null;
    if (root) root.remove();
    root = list = marker = null;
    loadedStart = nativeStart = 0;
  }

  function updateMarker() {
    if (!marker || !history) return;
    const total = nativeStart;
    const loaded = Math.max(0, nativeStart - loadedStart);
    marker.textContent = loadedStart <= 0
      ? `AntiCurse · start of visible history · ${total.toLocaleString()} older turns loaded`
      : `AntiCurse · ${loaded.toLocaleString()} / ${total.toLocaleString()} older visible turns loaded · scroll up for more`;
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
    loadedStart = nativeStart;
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

  function loadOlder() {
    if (!history || !list || !scroller || loadedStart <= 0) return;
    const batch = Math.max(4, Number(history.batchSize) || 16);
    const nextStart = Math.max(0, loadedStart - batch);
    const beforeHeight = height();
    const beforeTop = top();
    const fragment = document.createDocumentFragment();
    for (const message of history.messages.slice(nextStart, loadedStart)) fragment.appendChild(makeTurn(message));
    list.insertBefore(fragment, list.firstChild);
    loadedStart = nextStart;
    updateMarker();
    requestAnimationFrame(() => setTop(beforeTop + Math.max(0, height() - beforeHeight)));
  }

  function unloadDistant() {
    if (!history || !list || !scroller) return;
    const maxRendered = Math.max(32, Number(history.maxRendered) || 96);
    const turns = Array.from(list.children);
    if (turns.length <= maxRendered || top() < viewport() * 1.5) return;

    const removeCount = Math.min(turns.length - maxRendered, Math.max(4, Number(history.batchSize) || 16));
    const beforeHeight = height();
    const beforeTop = top();
    for (let i = 0; i < removeCount; i++) turns[i].remove();
    loadedStart = Math.min(nativeStart, loadedStart + removeCount);
    updateMarker();
    requestAnimationFrame(() => setTop(beforeTop - Math.max(0, beforeHeight - height())));
  }

  function check() {
    scrollScheduled = false;
    if (!history || !scroller || settings.mode !== "windowed-visible") return;
    if (top() <= Math.max(500, viewport() * 0.7)) loadOlder();
    else unloadDistant();
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
