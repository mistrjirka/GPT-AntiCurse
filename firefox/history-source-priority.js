/* Prefer already-captured Firefox history before any authenticated network refetch. */
(() => {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const bridge = globalThis.CGAntiCurseArchiveBridge;
  const isFirefox = !!(ext.runtime.getManifest().browser_specific_settings?.gecko);
  if (!isFirefox || !bridge || typeof bridge.buildFullVisibleArchive !== "function") return;

  const originalBuildFullVisibleArchive = bridge.buildFullVisibleArchive.bind(bridge);
  const pendingByConversation = new Map();
  let localHits = 0;
  let networkFallbacks = 0;
  let localMisses = 0;

  function archiveFromCapturedHistory(history, id) {
    if (!history || history.ok === false || !Array.isArray(history.messages)) return null;
    if (history.conversationId && history.conversationId !== id) return null;
    return {
      schemaVersion: 1,
      id,
      title: document.title || "ChatGPT conversation",
      sourceUrl: location.href,
      updatedAt: new Date().toISOString(),
      complete: true,
      messages: history.messages.map((message, index) => ({
        id: message?.id || `captured-history-${index}`,
        role: message?.role,
        text: typeof message?.text === "string" ? message.text : String(message?.text || ""),
        createTime: message?.createTime == null ? null : message.createTime
      }))
    };
  }

  async function buildLocalFirst(requestedId) {
    const id = String(requestedId || "").trim();
    if (!id) return originalBuildFullVisibleArchive(requestedId);

    const existing = pendingByConversation.get(id);
    if (existing) return existing;

    const operation = (async () => {
      try {
        const history = await ext.runtime.sendMessage({
          type: "cg-get-window-history",
          conversationId: id,
          maxDisplayMessages: 64
        });
        const archive = archiveFromCapturedHistory(history, id);
        if (archive) {
          localHits++;
          return {
            ok: true,
            archive,
            cached: true,
            sourcePages: 0,
            sourceAuth: "captured-firefox-history",
            sourceEndpointFamily: null
          };
        }
        localMisses++;
      } catch (_error) {
        localMisses++;
      }

      networkFallbacks++;
      return originalBuildFullVisibleArchive(id);
    })().finally(() => {
      if (pendingByConversation.get(id) === operation) pendingByConversation.delete(id);
    });

    pendingByConversation.set(id, operation);
    return operation;
  }

  bridge.buildFullVisibleArchive = buildLocalFirst;

  globalThis.CGAntiCurseHistorySourcePriority = {
    debug() {
      return {
        localHits,
        localMisses,
        networkFallbacks,
        pending: pendingByConversation.size
      };
    }
  };
})();
