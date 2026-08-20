/*
 * Transient history bridge and on-demand export capture.
 *
 * Normal browsing never persists conversation text and installs no mutation
 * observers. Chromium keeps the untouched response-derived visible history in
 * this content-script lifetime so the lightweight older-history view can work.
 * Firefox keeps equivalent per-tab history in its background event page.
 *
 * When the user explicitly exports, captureRenderedTail() merges the currently
 * rendered tail into that authoritative transient history and returns one
 * in-memory archive to the popup. Nothing is written to IndexedDB.
 */
(() => {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const CHANNEL = "__gpt_anticurse_v1__";
  const NETWORK_ARCHIVE_EVENT = "__gpt_anticurse_archive_ready__";
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const ROLE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
  const EXPORT_CAPTURE_TAIL_TURNS = 96;
  const DIAGNOSTICS = globalThis.CGAntiCurseDiagnostics;
  const scope = globalThis.CGConversationScope.create();
  const IS_FIREFOX = !!(ext.runtime.getManifest().browser_specific_settings?.gecko);

  let latestNetworkArchive = null;
  let confirmedConversationId = null;

  function recordIssue(code, error, extra) {
    if (DIAGNOSTICS && typeof DIAGNOSTICS.record === "function") return DIAGNOSTICS.record("archive", code, error, extra);
    console.warn(`[GPT AntiCurse] archive/${code}`, error, extra || "");
    return Promise.resolve(null);
  }

  function syncScope() {
    if (!scope.sync()) return false;
    const id = scope.currentId();
    if (!latestNetworkArchive || latestNetworkArchive.id !== id) latestNetworkArchive = null;
    confirmedConversationId = null;
    return true;
  }

  function confirmConversation(id) {
    syncScope();
    if (!id || id !== scope.currentId()) return false;
    confirmedConversationId = id;
    return true;
  }

  function acceptNetworkArchive(archive) {
    if (!archive || !archive.id || !Array.isArray(archive.messages)) {
      recordIssue("invalid-network-archive", "MAIN world supplied an invalid transient conversation history.");
      return false;
    }
    syncScope();
    const currentId = scope.currentId();
    if (currentId && archive.id !== currentId) return false;
    latestNetworkArchive = archive;
    confirmedConversationId = archive.id;
    window.dispatchEvent(new Event(NETWORK_ARCHIVE_EVENT));
    return true;
  }

  globalThis.CGAntiCurseArchiveBridge = {
    get(id) {
      syncScope();
      const requestedId = id || scope.currentId();
      if (!requestedId || !latestNetworkArchive || latestNetworkArchive.id !== requestedId) return null;
      return latestNetworkArchive;
    },
    debug() {
      syncScope();
      const id = scope.currentId();
      const current = latestNetworkArchive && latestNetworkArchive.id === id ? latestNetworkArchive : null;
      return {
        conversationId: id,
        transientArchive: !!current,
        transientMessages: current && Array.isArray(current.messages) ? current.messages.length : 0,
        archiveMode: "on-demand",
        persistentBackup: false,
        conversationConfirmed: !!id && confirmedConversationId === id,
        observersActive: false,
        capturePending: false,
        exportCaptureTailTurns: EXPORT_CAPTURE_TAIL_TURNS
      };
    }
  };

  function turnIndex(turn) {
    const testId = turn && turn.getAttribute ? turn.getAttribute("data-testid") : "";
    const match = String(testId || "").match(/^conversation-turn-(\d+)$/);
    return match ? Number(match[1]) : null;
  }

  function visibleText(roleElement) {
    const markdownBlocks = Array.from(roleElement.querySelectorAll(".markdown"));
    if (markdownBlocks.length) {
      const value = markdownBlocks.map((node) => node.textContent || "").join("\n\n").trim();
      if (value) return value;
    }
    return (roleElement.textContent || "").trim();
  }

  function collectRenderedMessages(limit = EXPORT_CAPTURE_TAIL_TURNS) {
    const root = document.querySelector("#thread");
    if (!root) return [];
    const result = [];
    const turns = Array.from(root.querySelectorAll(TURN_SELECTOR)).slice(-limit);
    if (turns.length) {
      for (const turn of turns) {
        const roleElement = turn.querySelector(ROLE_SELECTOR);
        if (!roleElement) continue;
        const role = roleElement.getAttribute("data-message-author-role");
        const text = visibleText(roleElement);
        if (text) result.push({ role, text, turnIndex: turnIndex(turn) });
      }
      return result;
    }
    for (const roleElement of Array.from(root.querySelectorAll(ROLE_SELECTOR)).slice(-limit)) {
      const role = roleElement.getAttribute("data-message-author-role");
      const text = visibleText(roleElement);
      if (text) result.push({ role, text, turnIndex: null });
    }
    return result;
  }

  function archiveFromHistory(history, id) {
    if (!history || history.ok === false || !Array.isArray(history.messages) || !id) return null;
    return {
      schemaVersion: 1,
      id,
      title: document.title || "ChatGPT conversation",
      sourceUrl: location.href,
      updatedAt: new Date().toISOString(),
      complete: true,
      messages: history.messages.map((message, index) => ({
        id: message.id || `history-${index}`,
        role: message.role,
        text: typeof message.text === "string" ? message.text : String(message.text || ""),
        createTime: message.createTime == null ? null : message.createTime
      }))
    };
  }

  async function authoritativeArchive(token) {
    syncScope();
    if (!scope.isCurrent(token) || !token.id) return null;
    if (latestNetworkArchive && latestNetworkArchive.id === token.id) return latestNetworkArchive;
    if (!IS_FIREFOX) return null;
    const history = await ext.runtime.sendMessage({
      type: "cg-get-window-history",
      conversationId: token.id,
      maxDisplayMessages: 64
    });
    if (!scope.isCurrent(token)) return null;
    return archiveFromHistory(history, token.id);
  }

  async function buildExportCapture() {
    syncScope();
    const token = scope.snapshot();
    if (!token.id) return { ok: false, reason: "not-a-conversation" };

    let baseArchive;
    try {
      baseArchive = await authoritativeArchive(token);
    } catch (error) {
      await recordIssue("export-history-read-failed", error, { conversationId: token.id });
      return { ok: false, reason: "history-read-failed", conversationId: token.id };
    }
    if (!scope.isCurrent(token)) return { ok: false, reason: "conversation-changed", conversationId: token.id };

    const rendered = collectRenderedMessages(EXPORT_CAPTURE_TAIL_TURNS);
    if (!baseArchive && !rendered.length) return { ok: false, reason: "archive-not-found", conversationId: token.id };
    return {
      ok: true,
      conversationId: token.id,
      title: document.title,
      sourceUrl: location.href,
      baseArchive,
      rendered
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.type !== "archive") return;
    acceptNetworkArchive(message.archive);
  });

  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;
    if (message.type === "cg-conversation-scope" && message.conversationId) {
      confirmConversation(message.conversationId);
      return false;
    }
    if (message.type === "cg-window-history" && message.history && message.history.conversationId) {
      confirmConversation(message.history.conversationId);
      return false;
    }
    if (message.type === "cg-build-export-archive") {
      buildExportCapture().then(sendResponse).catch((error) => {
        recordIssue("on-demand-export-failed", error);
        sendResponse({ ok: false, reason: String(error && error.message ? error.message : error) });
      });
      return true;
    }
    return false;
  });
})();
