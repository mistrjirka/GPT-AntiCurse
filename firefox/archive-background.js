/* Shared background-side persistence/message plumbing for conversation backups. */
(function (global) {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const DIAGNOSTICS = global.CGAntiCurseDiagnostics;
  const queues = new Map();

  function recordIssue(code, error, extra) {
    if (DIAGNOSTICS && typeof DIAGNOSTICS.record === "function") return DIAGNOSTICS.record("archive", code, error, extra);
    console.warn(`[GPT AntiCurse] archive/${code}`, error, extra || "");
    return Promise.resolve(null);
  }

  function serializeForConversation(id, operation) {
    const previous = queues.get(id) || Promise.resolve();
    const recovered = previous.catch((error) => {
      // The previous caller already receives its own rejection. Recover only so
      // one failed archive write cannot permanently poison this conversation's queue.
      console.warn("[GPT AntiCurse] Continuing archive queue after a failed operation", id, error);
    });
    const next = recovered.then(operation);
    queues.set(id, next);
    const cleanup = () => {
      if (queues.get(id) === next) queues.delete(id);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  async function saveNetworkArchive(archive) {
    if (!archive || !archive.id) return { ok: false, reason: "invalid-archive" };
    return serializeForConversation(archive.id, async () => {
      const existing = await CGArchiveStore.get(archive.id);
      const merged = CGArchive.mergeNetworkArchive(existing, archive);
      await CGArchiveStore.put(merged);
      return { ok: true, summary: CGArchive.archiveSummary(merged) };
    });
  }

  async function mergeRenderedArchive(message) {
    const id = message && message.conversationId;
    if (!id) return { ok: false, reason: "missing-conversation-id" };

    const sourceId = CGArchive.conversationIdFromUrl(message && message.sourceUrl);
    if (sourceId && sourceId !== id) {
      return {
        ok: false,
        reason: "conversation-scope-mismatch",
        conversationId: id,
        sourceConversationId: sourceId
      };
    }

    return serializeForConversation(id, async () => {
      const existing = await CGArchiveStore.get(id);
      const merged = CGArchive.mergeArchiveWithRendered(existing, message.messages, {
        id,
        title: message.title,
        sourceUrl: message.sourceUrl
      });
      if (!merged) return { ok: false, reason: "merge-failed", conversationId: id };
      await CGArchiveStore.put(merged);
      return { ok: true, conversationId: id, summary: CGArchive.archiveSummary(merged) };
    });
  }

  async function resolveArchive(message) {
    // Callers resolve the conversation id from the active content script. Do not
    // keep a tab->conversation global fallback: Chromium MV3 workers can restart
    // at any time, making such a cache look valid until it silently disappears.
    const id = message && message.conversationId;
    if (!id) return null;
    return serializeForConversation(id, () => CGArchiveStore.get(id));
  }

  async function archiveSummary(message) {
    const archive = await resolveArchive(message);
    return archive ? { ok: true, summary: CGArchive.archiveSummary(archive) } : { ok: false, reason: "archive-not-found" };
  }

  async function exportArchive(message) {
    const archive = await resolveArchive(message);
    if (!archive) return { ok: false, reason: "archive-not-found" };
    return {
      ok: true,
      summary: CGArchive.archiveSummary(archive),
      filename: CGArchive.archiveFilename(archive),
      markdown: CGArchiveExport.archiveToMarkdown(archive, { level: message.exportLevel })
    };
  }

  function respondAsync(promise, sendResponse, code) {
    promise.then(sendResponse).catch((error) => {
      recordIssue(code, error);
      sendResponse({ ok: false, reason: String(error && error.message ? error.message : error) });
    });
    return true;
  }

  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;
    if (message.type === "cg-save-network-archive") return respondAsync(saveNetworkArchive(message.archive), sendResponse, "save-network-failed");
    if (message.type === "cg-merge-rendered-archive") return respondAsync(mergeRenderedArchive(message), sendResponse, "merge-rendered-failed");
    if (message.type === "cg-get-archive-summary") return respondAsync(archiveSummary(message), sendResponse, "summary-read-failed");
    if (message.type === "cg-export-archive") return respondAsync(exportArchive(message), sendResponse, "export-read-failed");
    return false;
  });

  global.CGArchiveBackground = { saveNetworkArchive, mergeRenderedArchive, archiveSummary, exportArchive };
})(typeof globalThis !== "undefined" ? globalThis : this);
