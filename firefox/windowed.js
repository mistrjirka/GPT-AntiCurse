"use strict";

// Older visible history lives in an extension-owned overlay, never in ChatGPT's React tree.
(() => {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const IS_FIREFOX = typeof browser !== "undefined";
  const CHANNEL = "__gpt_anticurse_v1__";
  const LIMITED_MODES = new Set(["recent", "latest-visible", "windowed-visible"]);
  const DEFAULT_SETTINGS = { enabled: true, mode: "visible-history", maxDisplayMessages: 32 };

  let settings = { ...DEFAULT_SETTINGS }, history = null;
  let nativeScroller = null, nativeEventTarget = null, attachObserver = null;
  let host = null, shadow = null, viewport = null, list = null, marker = null, previousButton = null;
  let isOpen = false, loadedStart = 0, loadedEnd = 0, nativeStart = 0, scrollBusy = false;
  let lastNativeTop = 0, autoArmed = false, suppressAutoUntil = 0;

  function firstNativeTurn() {
    return document.querySelector('[data-testid^="conversation-turn-"]') ||
      document.querySelector("[data-message-author-role]")?.closest("section, article, [data-turn-id-container]") || null;
  }
  function fallbackScroller(el) {
    let node = el && el.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 40) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }
  function findNativeScroller() {
    // ChatGPT currently exposes its actual conversation scroller explicitly.
    return document.querySelector("[data-scroll-root]") || fallbackScroller(firstNativeTurn());
  }
  function nativeTop() { return nativeScroller ? Math.max(0, Number(nativeScroller.scrollTop) || 0) : 0; }
  function nativeScrollable() { return !!nativeScroller && nativeScroller.scrollHeight > nativeScroller.clientHeight + 40; }

  function detachNativeWatch() {
    if (nativeEventTarget) {
      nativeEventTarget.removeEventListener("wheel", onNativeWheel, true);
      nativeEventTarget.removeEventListener("scroll", onNativeScroll, true);
    }
    nativeEventTarget = nativeScroller = null;
  }
  function attachNativeWatch() {
    if (!history || !settings.enabled || !LIMITED_MODES.has(settings.mode)) return false;
    const next = findNativeScroller();
    if (!next) return false;
    const target = (next === document.scrollingElement || next === document.documentElement) ? window : next;
    if (nativeScroller === next && nativeEventTarget === target) return true;
    detachNativeWatch();
    nativeScroller = next; nativeEventTarget = target;
    lastNativeTop = nativeTop(); autoArmed = lastNativeTop > 64;
    target.addEventListener("wheel", onNativeWheel, { passive: false, capture: true });
    target.addEventListener("scroll", onNativeScroll, { passive: true, capture: true });
    return true;
  }
  function ensureNativeWatch() {
    if (attachNativeWatch() || attachObserver || !document.documentElement) return;
    attachObserver = new MutationObserver(() => {
      if (attachNativeWatch()) { attachObserver.disconnect(); attachObserver = null; }
    });
    attachObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function pageSize() { return Math.max(4, Math.min(500, Number(history?.pageSize) || Number(settings.maxDisplayMessages) || 32)); }
  function maxRendered() { return Math.max(pageSize(), Math.min(500, Number(history?.maxRendered) || pageSize() * 3)); }
  function makeTurn(message, index) {
    const turn = document.createElement("article"); turn.className = `turn ${message.role === "user" ? "user" : "assistant"}`; turn.dataset.index = String(index);
    const head = document.createElement("div"); head.className = "head"; head.textContent = message.role === "user" ? "You" : "Assistant";
    const body = document.createElement("div"); body.className = "body"; body.textContent = message.text || "[Non-text visible message]";
    turn.append(head, body); return turn;
  }

  function ensureOverlay() {
    if (host?.isConnected) return;
    host = document.createElement("div"); host.id = "cg-window-history-host";
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
    document.documentElement.appendChild(host); shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>
      :host{all:initial}.overlay{position:fixed;inset:0;display:none;pointer-events:auto;background:#111113;color:#ececec;font:14px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.overlay.open{display:flex;flex-direction:column}.topbar{display:flex;align-items:center;gap:8px;padding:9px 14px;border-bottom:1px solid rgba(255,255,255,.09);background:#171719}.brand{font-weight:700;color:#67e8d3}.marker{flex:1;min-width:0;color:#92969e;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}button{border:1px solid rgba(255,255,255,.13);border-radius:8px;background:#242427;color:#f3f4f6;padding:6px 9px;font:600 12px system-ui;cursor:pointer}button:hover{background:#303034}button:disabled{opacity:.4;cursor:default}.viewport{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}.list{width:min(52rem,calc(100% - 32px));margin:auto;padding:18px 0 54px;display:grid;gap:16px}.turn{padding:10px 14px;border-radius:13px;overflow-wrap:anywhere}.turn.user{margin-left:min(14%,5rem);background:#2b2b2e}.turn.assistant{margin-right:min(8%,3rem)}.head{color:#6ee7d2;font-size:11px;font-weight:700;margin-bottom:5px}.body{white-space:pre-wrap}.hint{width:max-content;max-width:calc(100% - 32px);margin:12px auto 0;color:#777f88;font-size:11px;text-align:center}
    </style><section class="overlay" role="dialog" aria-label="Older visible ChatGPT history"><div class="topbar"><span class="brand">AntiCurse history</span><span class="marker"></span><button class="previous" type="button"></button><button class="back" type="button">Back to recent</button></div><div class="viewport" tabindex="0"><div class="hint">Visible user/assistant turns only. Scroll to page through older history.</div><div class="list"></div></div></section>`;
    host._cgOverlay = shadow.querySelector(".overlay"); viewport = shadow.querySelector(".viewport"); list = shadow.querySelector(".list"); marker = shadow.querySelector(".marker"); previousButton = shadow.querySelector(".previous");
    previousButton.addEventListener("click", prependOlder); shadow.querySelector(".back").addEventListener("click", closeOverlay);
    viewport.addEventListener("scroll", onOverlayScroll, { passive: true }); viewport.addEventListener("wheel", onOverlayWheel, { passive: false }); viewport.addEventListener("keydown", e => { if (e.key === "Escape") closeOverlay(); });
  }
  function updateMarker() {
    if (!marker || !history) return;
    const shown = Math.max(0, loadedEnd - loadedStart);
    marker.textContent = `${shown.toLocaleString()} shown · ${Math.max(0, loadedStart + 1).toLocaleString()}–${loadedEnd.toLocaleString()} of ${nativeStart.toLocaleString()} older turns`;
    const count = Math.min(pageSize(), loadedStart); previousButton.textContent = count ? `Load previous ${count}` : "Start reached"; previousButton.disabled = !count;
  }
  function renderInitialWindow() {
    nativeStart = Math.max(0, history.messages.length - Math.max(0, Number(history.nativeVisibleCount) || 0)); loadedEnd = nativeStart; loadedStart = Math.max(0, loadedEnd - pageSize()); list.replaceChildren();
    const f = document.createDocumentFragment(); for (let i = loadedStart; i < loadedEnd; i++) f.appendChild(makeTurn(history.messages[i], i)); list.appendChild(f); updateMarker();
  }
  function openOverlay() {
    if (isOpen || !history || !LIMITED_MODES.has(settings.mode)) return false;
    nativeStart = Math.max(0, history.messages.length - Math.max(0, Number(history.nativeVisibleCount) || 0)); if (nativeStart <= 0) return false;
    ensureOverlay(); renderInitialWindow(); isOpen = true; host._cgOverlay.classList.add("open");
    requestAnimationFrame(() => { viewport.scrollTop = viewport.scrollHeight; try { viewport.focus({ preventScroll: true }); } catch (_) { viewport.focus(); } }); return true;
  }
  function closeOverlay() {
    if (!isOpen) return; isOpen = false; host?._cgOverlay?.classList.remove("open"); suppressAutoUntil = performance.now() + 700; autoArmed = false;
    if (nativeScroller) { nativeScroller.scrollTop = 0; lastNativeTop = 0; }
  }
  function prependOlder() {
    if (!history || loadedStart <= 0) return false;
    const next = Math.max(0, loadedStart - pageSize()), anchor = list.firstElementChild, before = anchor?.getBoundingClientRect().top || 0, f = document.createDocumentFragment();
    for (let i = next; i < loadedStart; i++) f.appendChild(makeTurn(history.messages[i], i)); list.insertBefore(f, list.firstChild); loadedStart = next;
    while (list.children.length > maxRendered()) { list.lastElementChild.remove(); loadedEnd--; } updateMarker(); if (anchor) viewport.scrollTop += anchor.getBoundingClientRect().top - before; return true;
  }
  function appendNewer() {
    if (!history || loadedEnd >= nativeStart) return false;
    const next = Math.min(nativeStart, loadedEnd + pageSize()), anchor = list.lastElementChild, before = anchor?.getBoundingClientRect().top || 0, f = document.createDocumentFragment();
    for (let i = loadedEnd; i < next; i++) f.appendChild(makeTurn(history.messages[i], i)); list.appendChild(f); loadedEnd = next;
    while (list.children.length > maxRendered()) { list.firstElementChild.remove(); loadedStart++; } updateMarker(); if (anchor) viewport.scrollTop += anchor.getBoundingClientRect().top - before; return true;
  }
  function onOverlayScroll() {
    if (!isOpen || scrollBusy) return; scrollBusy = true; requestAnimationFrame(() => { scrollBusy = false; if (!isOpen) return; if (viewport.scrollTop < 260) prependOlder(); const gap = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop; if (gap < 260 && loadedEnd < nativeStart) appendNewer(); });
  }
  function onOverlayWheel(e) { if (!isOpen) return; const gap = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop; if (e.deltaY > 0 && loadedEnd >= nativeStart && gap < 3) { e.preventDefault(); closeOverlay(); } }
  function onNativeScroll() {
    if (!history || isOpen || !settings.enabled || settings.mode !== "windowed-visible" || !nativeScroller) return;
    const current = nativeTop(); if (current > 64) autoArmed = true; const movingUp = current < lastNativeTop - .5;
    if (autoArmed && movingUp && current <= 10 && nativeScrollable() && performance.now() >= suppressAutoUntil) openOverlay(); lastNativeTop = current;
  }
  function onNativeWheel(e) { if (!isOpen && history && settings.enabled && settings.mode === "windowed-visible" && e.deltaY < 0 && nativeTop() <= 12 && nativeScrollable() && performance.now() >= suppressAutoUntil) { e.preventDefault(); openOverlay(); } }

  function destroyOverlay() { closeOverlay(); host?.remove(); host = shadow = viewport = list = marker = previousButton = null; }
  function clear() { if (attachObserver) { attachObserver.disconnect(); attachObserver = null; } detachNativeWatch(); destroyOverlay(); history = null; }
  function applyHistory(value) { history = value && Array.isArray(value.messages) ? value : null; if (!history || !settings.enabled || !LIMITED_MODES.has(settings.mode)) { destroyOverlay(); return; } ensureNativeWatch(); }
  function manualOpen() { if (!settings.enabled) return { ok:false, reason:"guard-disabled" }; if (!LIMITED_MODES.has(settings.mode)) return { ok:false, reason:"mode-has-full-history" }; if (!history) return { ok:false, reason:"no-history-archive" }; const ok = openOverlay(); return { ok, reason: ok ? undefined : "no-older-visible-turns" }; }

  ext.storage.local.get(DEFAULT_SETTINGS).then(saved => { settings = { ...DEFAULT_SETTINGS, ...saved }; if (IS_FIREFOX && LIMITED_MODES.has(settings.mode) && settings.enabled) ext.runtime.sendMessage({ type:"cg-get-window-history" }).then(applyHistory).catch(() => {}); }).catch(() => {});
  ext.storage.onChanged.addListener((changes, area) => { if (area !== "local") return; for (const key of Object.keys(DEFAULT_SETTINGS)) if (changes[key]) settings[key] = changes[key].newValue; if (!settings.enabled || !LIMITED_MODES.has(settings.mode)) clear(); else if (IS_FIREFOX) ext.runtime.sendMessage({ type:"cg-get-window-history" }).then(applyHistory).catch(() => {}); else if (history) ensureNativeWatch(); });
  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "cg-open-window-history") { const result = manualOpen(); if (IS_FIREFOX) return Promise.resolve(result); sendResponse?.(result); return false; }
    if (IS_FIREFOX && message?.type === "cg-window-history") applyHistory(message.history);
    return undefined;
  });
  if (!IS_FIREFOX) window.addEventListener("message", e => { if (e.source !== window || e.origin !== location.origin) return; const msg = e.data; if (msg?.channel === CHANNEL && msg.type === "history") applyHistory(msg.history); });
})();
