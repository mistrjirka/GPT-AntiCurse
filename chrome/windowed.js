"use strict";

// Experimental older-history reader. The UI is deliberately rendered OUTSIDE
// ChatGPT's React-owned conversation subtree. The newest turns remain native;
// older visible turns are shown in a bounded extension-owned overlay.
(() => {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const IS_FIREFOX = typeof browser !== "undefined";
  const CHANNEL = "__gpt_anticurse_v1__";
  const DEFAULT_SETTINGS = { enabled: true, mode: "visible-history", maxDisplayMessages: 32 };

  let settings = { ...DEFAULT_SETTINGS };
  let history = null;
  let nativeScroller = null;
  let nativeWheelTarget = null;
  let attachObserver = null;
  let host = null;
  let shadow = null;
  let viewport = null;
  let list = null;
  let marker = null;
  let isOpen = false;
  let loadedStart = 0;
  let loadedEnd = 0;
  let nativeStart = 0;
  let scrollBusy = false;

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
  function nativeTop() { return nativeScroller ? nativeScroller.scrollTop : 0; }
  function detachNativeWatch() {
    if (nativeWheelTarget) nativeWheelTarget.removeEventListener("wheel", onNativeWheel, true);
    nativeWheelTarget = null; nativeScroller = null;
  }
  function attachNativeWatch() {
    if (!history || !settings.enabled || settings.mode !== "windowed-visible") return false;
    const turn = firstNativeTurn(); if (!turn) return false;
    const nextScroller = findScroller(turn);
    const target = (nextScroller === document.scrollingElement || nextScroller === document.documentElement) ? window : nextScroller;
    if (nativeScroller === nextScroller && nativeWheelTarget === target) return true;
    detachNativeWatch(); nativeScroller = nextScroller; nativeWheelTarget = target;
    nativeWheelTarget.addEventListener("wheel", onNativeWheel, { passive: false, capture: true });
    return true;
  }
  function ensureNativeWatch() {
    if (attachNativeWatch()) return;
    if (attachObserver || !document.documentElement) return;
    attachObserver = new MutationObserver(() => {
      if (attachNativeWatch()) { attachObserver.disconnect(); attachObserver = null; }
    });
    attachObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  function makeTurn(message, index) {
    const turn = document.createElement("article"); turn.className = `turn ${message.role === "user" ? "user" : "assistant"}`; turn.dataset.index = String(index);
    const head = document.createElement("div"); head.className = "head"; head.textContent = message.role === "user" ? "You" : "Assistant";
    const body = document.createElement("div"); body.className = "body"; body.textContent = message.text || "[Non-text visible message]";
    turn.append(head, body); return turn;
  }
  function ensureOverlay() {
    if (host && host.isConnected) return;
    host = document.createElement("div"); host.id = "cg-window-history-host";
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>
      :host{all:initial}.overlay{position:fixed;inset:0;z-index:2147483646;display:none;pointer-events:auto;background:rgba(10,10,12,.985);color:#ececec;font:14px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.overlay.open{display:flex;flex-direction:column}.topbar{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.09);background:rgba(18,18,20,.98)}.brand{font-weight:750;color:#67e8d3}.marker{flex:1;min-width:0;color:#9ca3af;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}button{appearance:none;border:1px solid rgba(255,255,255,.14);border-radius:9px;background:#262629;color:#f3f4f6;padding:6px 10px;font:600 12px system-ui,sans-serif;cursor:pointer}button:hover{background:#303034}.viewport{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.list{width:min(52rem,calc(100% - 32px));margin:0 auto;padding:24px 0 60px;display:grid;gap:18px}.turn{padding:12px 15px;border-radius:14px;overflow-wrap:anywhere}.turn.user{margin-left:min(14%,5rem);background:#2f2f32}.turn.assistant{margin-right:min(8%,3rem)}.head{color:#6ee7d2;font-size:11px;font-weight:750;margin-bottom:6px}.body{white-space:pre-wrap}.hint{width:max-content;max-width:calc(100% - 32px);margin:14px auto 0;color:#819099;font-size:11px;text-align:center}
    </style><section class="overlay" role="dialog" aria-label="Older visible ChatGPT history"><div class="topbar"><span class="brand">GPT AntiCurse history</span><span class="marker"></span><button type="button">Back to recent chat</button></div><div class="viewport"><div class="hint">Scroll up for older visible turns · scroll down past the newest archived turn to return</div><div class="list"></div></div></section>`;
    const overlay = shadow.querySelector(".overlay"); viewport = shadow.querySelector(".viewport"); list = shadow.querySelector(".list"); marker = shadow.querySelector(".marker");
    shadow.querySelector("button").addEventListener("click", closeOverlay); viewport.tabIndex = 0;
    viewport.addEventListener("scroll", onOverlayScroll, { passive: true }); viewport.addEventListener("wheel", onOverlayWheel, { passive: false });
    viewport.addEventListener("keydown", (event) => { if (event.key === "Escape") closeOverlay(); }); host._cgOverlay = overlay;
  }
  function updateMarker() {
    if (!marker || !history) return;
    const shown = Math.max(0, loadedEnd - loadedStart);
    marker.textContent = `${shown.toLocaleString()} shown · older visible history ${Math.max(0, loadedStart + 1).toLocaleString()}–${loadedEnd.toLocaleString()} of ${nativeStart.toLocaleString()}`;
  }
  function renderInitialWindow() {
    if (!history || !list) return;
    const maxRendered = Math.max(24, Math.min(160, Number(history.maxRendered) || 72));
    nativeStart = Math.max(0, history.messages.length - Math.max(0, Number(history.nativeVisibleCount) || 0)); loadedEnd = nativeStart; loadedStart = Math.max(0, loadedEnd - maxRendered);
    list.replaceChildren(); const fragment = document.createDocumentFragment();
    for (let i = loadedStart; i < loadedEnd; i++) fragment.appendChild(makeTurn(history.messages[i], i)); list.appendChild(fragment); updateMarker();
  }
  function openOverlay() {
    if (isOpen || !history) return;
    nativeStart = Math.max(0, history.messages.length - Math.max(0, Number(history.nativeVisibleCount) || 0)); if (nativeStart <= 0) return;
    ensureOverlay(); renderInitialWindow(); isOpen = true; host._cgOverlay.classList.add("open");
    requestAnimationFrame(() => { viewport.scrollTop = viewport.scrollHeight; try { viewport.focus({ preventScroll: true }); } catch (_) { viewport.focus(); } });
  }
  function closeOverlay() { if (!isOpen) return; isOpen = false; if (host && host._cgOverlay) host._cgOverlay.classList.remove("open"); if (nativeScroller) nativeScroller.scrollTop = 0; }
  function prependOlder() {
    if (!history || !list || loadedStart <= 0) return;
    const batch = Math.max(4, Math.min(32, Number(history.batchSize) || 16)), maxRendered = Math.max(24, Math.min(160, Number(history.maxRendered) || 72)), nextStart = Math.max(0, loadedStart - batch);
    const anchor = list.firstElementChild, before = anchor ? anchor.getBoundingClientRect().top : 0, fragment = document.createDocumentFragment();
    for (let i = nextStart; i < loadedStart; i++) fragment.appendChild(makeTurn(history.messages[i], i)); list.insertBefore(fragment, list.firstChild); loadedStart = nextStart;
    while (list.children.length > maxRendered) { list.lastElementChild.remove(); loadedEnd--; } updateMarker(); if (anchor) viewport.scrollTop += anchor.getBoundingClientRect().top - before;
  }
  function appendNewer() {
    if (!history || !list || loadedEnd >= nativeStart) return;
    const batch = Math.max(4, Math.min(32, Number(history.batchSize) || 16)), maxRendered = Math.max(24, Math.min(160, Number(history.maxRendered) || 72)), nextEnd = Math.min(nativeStart, loadedEnd + batch);
    const anchor = list.lastElementChild, before = anchor ? anchor.getBoundingClientRect().top : 0, fragment = document.createDocumentFragment();
    for (let i = loadedEnd; i < nextEnd; i++) fragment.appendChild(makeTurn(history.messages[i], i)); list.appendChild(fragment); loadedEnd = nextEnd;
    while (list.children.length > maxRendered) { list.firstElementChild.remove(); loadedStart++; } updateMarker(); if (anchor) viewport.scrollTop += anchor.getBoundingClientRect().top - before;
  }
  function onOverlayScroll() {
    if (!isOpen || scrollBusy) return; scrollBusy = true;
    requestAnimationFrame(() => { scrollBusy = false; if (!isOpen || !viewport) return; if (viewport.scrollTop < 360) prependOlder(); const bottomGap = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop; if (bottomGap < 360 && loadedEnd < nativeStart) appendNewer(); });
  }
  function onOverlayWheel(event) { if (!isOpen || !viewport) return; const bottomGap = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop; if (event.deltaY > 0 && loadedEnd >= nativeStart && bottomGap < 3) { event.preventDefault(); closeOverlay(); } }
  function onNativeWheel(event) { if (isOpen || !history || !settings.enabled || settings.mode !== "windowed-visible") return; if (event.deltaY < 0 && nativeTop() <= 2) { event.preventDefault(); openOverlay(); } }
  function destroyOverlay() { closeOverlay(); if (host) host.remove(); host = shadow = viewport = list = marker = null; }
  function clear() { if (attachObserver) { attachObserver.disconnect(); attachObserver = null; } detachNativeWatch(); destroyOverlay(); history = null; }
  function applyHistory(value) { history = value && Array.isArray(value.messages) ? value : null; if (!history || !settings.enabled || settings.mode !== "windowed-visible") { destroyOverlay(); return; } ensureNativeWatch(); }
  ext.storage.local.get(DEFAULT_SETTINGS).then((saved) => { settings = { ...DEFAULT_SETTINGS, ...saved }; if (IS_FIREFOX && settings.mode === "windowed-visible" && settings.enabled) ext.runtime.sendMessage({ type: "cg-get-window-history" }).then(applyHistory).catch(() => {}); }).catch(() => {});
  ext.storage.onChanged.addListener((changes, area) => { if (area !== "local") return; for (const key of Object.keys(DEFAULT_SETTINGS)) if (changes[key]) settings[key] = changes[key].newValue; if (!settings.enabled || settings.mode !== "windowed-visible") clear(); else if (IS_FIREFOX) ext.runtime.sendMessage({ type: "cg-get-window-history" }).then(applyHistory).catch(() => {}); else if (history) ensureNativeWatch(); });
  if (IS_FIREFOX) ext.runtime.onMessage.addListener((message) => { if (message && message.type === "cg-window-history") applyHistory(message.history); });
  else window.addEventListener("message", (event) => { if (event.source !== window || event.origin !== location.origin) return; const msg = event.data; if (msg && msg.channel === CHANNEL && msg.type === "history") applyHistory(msg.history); });
})();
