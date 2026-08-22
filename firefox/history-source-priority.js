/* Prefer already-captured Firefox history before any authenticated network refetch. */
(() => {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const bridge = globalThis.CGAntiCurseArchiveBridge;
  const isFirefox = !!(ext.runtime.getManifest().browser_specific_settings?.gecko);
  if (!isFirefox || !bridge || typeof bridge.buildFullVisibleArchive !== "function") return;

  const originalBuildFullVisibleArchive = bridge.buildFullVisibleArchive.bind(bridge);
  const pendingByConversation = new Map();
  const rateLimitByConversation = new Map();
  const RATE_LIMIT_BASE_MS = 15_000;
  const RATE_LIMIT_MAX_MS = 300_000;
  let localHits = 0;
  let networkFallbacks = 0;
  let localMisses = 0;
  let rateLimitedSkips = 0;

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

  function rateLimitState(id) {
    const state = rateLimitByConversation.get(id);
    if (!state) return null;
    if (state.until > Date.now()) return state;
    rateLimitByConversation.delete(id);
    return null;
  }

  function noteRateLimit(id) {
    const previous = rateLimitByConversation.get(id);
    const failures = Math.min(6, Math.max(0, Number(previous?.failures) || 0) + 1);
    const delayMs = Math.min(RATE_LIMIT_MAX_MS, RATE_LIMIT_BASE_MS * (2 ** (failures - 1)));
    const state = { failures, until: Date.now() + delayMs, delayMs };
    rateLimitByConversation.set(id, state);
    return state;
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
          rateLimitByConversation.delete(id);
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

      const limited = rateLimitState(id);
      if (limited) {
        rateLimitedSkips++;
        return {
          ok: false,
          reason: "history-network-rate-limit-backoff",
          status: 429,
          retryInMs: Math.max(1, limited.until - Date.now())
        };
      }

      networkFallbacks++;
      const result = await originalBuildFullVisibleArchive(id);
      if (result?.ok === true) {
        rateLimitByConversation.delete(id);
        return result;
      }
      if (result?.reason === "http-status" && Number(result.status) === 429) {
        const state = noteRateLimit(id);
        return { ...result, retryInMs: state.delayMs };
      }
      return result;
    })().finally(() => {
      if (pendingByConversation.get(id) === operation) pendingByConversation.delete(id);
    });

    pendingByConversation.set(id, operation);
    return operation;
  }

  bridge.buildFullVisibleArchive = buildLocalFirst;

  globalThis.CGAntiCurseHistorySourcePriority = {
    debug() {
      const now = Date.now();
      let maxRetryInMs = 0;
      let rateLimitedConversations = 0;
      for (const state of rateLimitByConversation.values()) {
        const remaining = Math.max(0, Number(state?.until) - now);
        if (!remaining) continue;
        rateLimitedConversations++;
        maxRetryInMs = Math.max(maxRetryInMs, remaining);
      }
      return {
        localHits,
        localMisses,
        networkFallbacks,
        rateLimitedSkips,
        rateLimitedConversations,
        maxRetryInMs,
        pending: pendingByConversation.size
      };
    }
  };
})();
