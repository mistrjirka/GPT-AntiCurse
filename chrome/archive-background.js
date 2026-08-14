/* Shared background-side persistence/message plumbing for conversation backups. */
(function (global) {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const DIAGNOSTICS = global.CGAntiCurseDiagnostics;
  const activeByTab = new Map();
  const queues = new Map();

  function recordIssue(code, error, extra) {
    if (DIAGNOSTICS && typeof DIAGNOSTICS.record === "function") return DIAGNOSTICS.record("archive", code, error, extra);
    console.warn(`[GPT AntiCurse] archive/${code}`, error, extra || "");
    return Promise.resolve(null);
  }

  function queueFor(id, operation) {
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

  function rememberTab(tabId, id) {
    if (Number.isInteger(tabId) && tabId >= 0 && id) activeByTab.set(tabId, id);
  }

  async function saveNetworkArchive(archive, tabId) {
    if (!archive || !archive.id) return { ok: false, reason: "invalid-archive" };
    rememberTab(tabId, archive.id);
    return queueFor(archive.id, async () => {
      const existing = await CGArchiveStore.get(archive.id);
      const merged = CGArchive.mergeNetworkArchive(existing, archive);
      await CGArchiveStore.put(merged);
      return { ok: true, summary: CGArchive.archiveSummary(merged) };
    });
  }

  async function mergeRenderedArchive(message, tabId) {
    const id = message && message.conversationId;
    if (!id) return { ok: false, reason: "missing-conversation-id" };
    rememberTab(tabId, id);

    return queueFor(id, async () => {
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
    const id = message && (message.conversationId || activeByTab.get(message.tabId));
    if (!id) return null;
    return queueFor(id, () => CGArchiveStore.get(id));
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
      markdown: CGArchive.archiveToMarkdown(archive, { level: message.exportLevel })
    };
  }

  function asyncResponse(promise, sendResponse, code) {
    promise.then(sendResponse).catch((error) => {
      recordIssue(code, error);
      sendResponse({ ok: false, reason: String(error && error.message ? error.message : error) });
    });
    return true;
  }

  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return false;
    const tabId = sender && sender.tab ? sender.tab.id : message.tabId;

    if (message.type === "cg-save-network-archive") return asyncResponse(saveNetworkArchive(message.archive, tabId), sendResponse, "save-network-failed");
    if (message.type === "cg-merge-rendered-archive") return asyncResponse(mergeRenderedArchive(message, tabId), sendResponse, "merge-rendered-failed");
    if (message.type === "cg-get-archive-summary") return asyncResponse(archiveSummary(message), sendResponse, "summary-read-failed");
    if (message.type === "cg-export-archive") return asyncResponse(exportArchive(message), sendResponse, "export-read-failed");
    return false;
  });

  if (ext.tabs && ext.tabs.onRemoved) ext.tabs.onRemoved.addListener((tabId) => activeByTab.delete(tabId));

  global.CGArchiveBackground = { saveNetworkArchive, mergeRenderedArchive, archiveSummary, exportArchive };
})(typeof globalThis !== "undefined" ? globalThis : this);
