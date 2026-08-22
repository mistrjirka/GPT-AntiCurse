/* On-demand, content-free health snapshot for debugging live browser failures. */
(() => {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const DOM_GATE = globalThis.CGAntiCurseDomReady;
  const scope = globalThis.CGConversationScope.create();

  function findScroller() {
    const marked = document.querySelector("[data-scroll-root]");
    if (marked && (marked.querySelector("#thread") || marked.querySelector('[data-testid^="conversation-turn-"]'))) return marked;
    return document.scrollingElement || document.documentElement;
  }

  function summarizeHistoryResult(value) {
    if (!value || typeof value !== "object") return { ok: false, reason: "no-response" };
    return {
      ok: value.ok !== false,
      reason: value.reason || null,
      error: value.error || null,
      source: value.source || null,
      conversationId: value.conversationId || null,
      messageCount: Array.isArray(value.messages) ? value.messages.length : 0,
      nativeVisibleCount: Number.isFinite(Number(value.nativeVisibleCount)) ? Number(value.nativeVisibleCount) : null,
      pageSize: Number.isFinite(Number(value.pageSize)) ? Number(value.pageSize) : null,
      maxRendered: Number.isFinite(Number(value.maxRendered)) ? Number(value.maxRendered) : null
    };
  }

  async function backendHistory(id, limit) {
    if (!id) return { ok: false, reason: "not-a-conversation" };
    try {
      const value = await ext.runtime.sendMessage({
        type: "cg-get-window-history",
        conversationId: id,
        maxDisplayMessages: limit
      });
      return summarizeHistoryResult(value);
    } catch (error) {
      return { ok: false, reason: "runtime-message-failed", error: String(error && error.message ? error.message : error) };
    }
  }

  function historyControllerState() {
    const controller = globalThis.CGAntiCurseHistoryDebug;
    if (!controller || typeof controller.debug !== "function") return { present: !!controller };
    try {
      return { present: true, ...controller.debug() };
    } catch (error) {
      return { present: true, debugError: String(error && error.message ? error.message : error) };
    }
  }

  async function snapshot() {
    const saved = await ext.storage.local.get({
      enabled: true,
      mode: "windowed-visible",
      maxDisplayMessages: 64,
      showGuardNotice: true,
      stallRecoveryEnabled: true,
      archiveExportLevel: "progress",
      cgLastIssue: null
    });
    const id = scope.currentId();
    const scroller = findScroller();
    const thread = document.querySelector("#thread");
    const host = document.querySelector("#cg-window-history-host");
    const control = host && host.querySelector(".cg-history-control");
    const button = host && host.querySelector(".cg-history-previous");
    const marker = host && host.querySelector(".cg-history-marker");
    const bridge = globalThis.CGAntiCurseArchiveBridge;
    let bridgeState = null;
    try {
      bridgeState = bridge && typeof bridge.debug === "function" ? bridge.debug() : { present: !!bridge };
    } catch (error) {
      bridgeState = { present: !!bridge, debugError: String(error && error.message ? error.message : error) };
    }

    return {
      version: ext.runtime.getManifest().version,
      conversationId: id,
      documentReadyState: document.readyState,
      domGateReady: !DOM_GATE || DOM_GATE.isReady(),
      settings: {
        enabled: saved.enabled !== false,
        mode: saved.mode === "windowed-visible" ? "windowed-visible" : "recent",
        maxDisplayMessages: Number(saved.maxDisplayMessages) || 64,
        showGuardNotice: saved.showGuardNotice !== false,
        stallRecoveryEnabled: saved.stallRecoveryEnabled !== false,
        archiveMode: "on-demand",
        archiveExportLevel: saved.archiveExportLevel || "progress"
      },
      native: {
        threadPresent: !!thread,
        nativeTurnCount: thread ? thread.querySelectorAll('[data-testid^="conversation-turn-"]').length : 0,
        scrollerPresent: !!scroller,
        scrollTop: scroller ? Math.round(Number(scroller.scrollTop) || 0) : null,
        scrollHeight: scroller ? Math.round(Number(scroller.scrollHeight) || 0) : null,
        clientHeight: scroller ? Math.round(Number(scroller.clientHeight) || 0) : null,
        fromTopAttribute: !!(scroller && scroller.hasAttribute && scroller.hasAttribute("data-scroll-from-top")),
        fromEndAttribute: !!(scroller && scroller.hasAttribute && scroller.hasAttribute("data-scroll-from-end"))
      },
      historyDom: {
        hostPresent: !!host,
        hostBeforeThread: !!(host && thread && host.parentElement === thread.parentElement && host.nextSibling === thread),
        controlHidden: control ? !!control.hidden : null,
        buttonHidden: button ? !!button.hidden : null,
        buttonText: button ? button.textContent : null,
        markerText: marker ? marker.textContent : null,
        mountedPages: host ? host.querySelectorAll(".cg-history-page").length : 0,
        syntheticTurns: host ? host.querySelectorAll(".cg-history-turn").length : 0
      },
      historyController: historyControllerState(),
      stallRecovery: (() => {
        const recovery = globalThis.CGAntiCurseStallRecovery;
        try { return recovery && typeof recovery.debug === "function" ? { present: true, ...recovery.debug() } : { present: !!recovery }; }
        catch (error) { return { present: !!recovery, debugError: String(error && error.message ? error.message : error) }; }
      })(),
      archiveBridge: bridgeState,
      backendHistory: await backendHistory(id, Number(saved.maxDisplayMessages) || 64),
      lastIssue: saved.cgLastIssue || null
    };
  }

  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "cg-get-debug-state") return false;
    snapshot().then((state) => sendResponse({ ok: true, state })).catch((error) => {
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
    });
    return true;
  });
})();
