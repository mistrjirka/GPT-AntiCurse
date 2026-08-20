"use strict";
(() => {
  const popupContext = globalThis.CGPopupContext;
  const ext = popupContext.ext;
  const extensionManifest = popupContext.manifest;
  const IS_FIREFOX = popupContext.isFirefoxPackage;
  const PACKAGE_TARGET = popupContext.packageTarget;
  const RUNTIME_BROWSER = popupContext.runtimeBrowser;
  const BACKGROUND_KIND = popupContext.backgroundKind;
  const diagnostics = popupContext.diagnostics;
  const status = document.getElementById("archiveStatus");
  const summary = document.getElementById("archiveSummary");
  const exportLevel = document.getElementById("archiveExportLevel");
  const exportHelp = document.getElementById("archiveExportHelp");
  const exportButton = document.getElementById("exportMarkdown");
  const continueButton = document.getElementById("continueChat");
  const debugButton = document.getElementById("exportDebug");
  const feedback = document.getElementById("feedback");
  const EXPORT_HELP = {
    clean: "User messages and final assistant answers only. Best for a compact shareable transcript.",
    progress: "Recommended. Keeps readable assistant progress and plans, but omits raw tool-call noise.",
    full: "Includes raw tool calls and plan payloads. Best for debugging or technical continuation."
  };

  function buttons(on) { exportButton.disabled = !on; continueButton.disabled = !on; }
  function setArchiveStatus(text, state) { status.textContent = text; status.dataset.state = state; }
  function updateExportHelp() { exportHelp.textContent = EXPORT_HELP[exportLevel.value] || EXPORT_HELP.progress; }
  function errorText(error) { return popupContext.errorText(error); }
  function recordIssue(scope, code, error, extra) {
    if (diagnostics && typeof diagnostics.record === "function") return diagnostics.record(scope, code, error, extra);
    console.warn(`[GPT AntiCurse] ${scope}/${code}`, error, extra || "");
    return Promise.resolve(null);
  }
  async function clearPageBridgeIssue() {
    if (!diagnostics || typeof diagnostics.clear !== "function") return;
    await diagnostics.clear("bridge");
    await diagnostics.clear("archive", "popup-page-bridge-failed");
  }
  async function hasChromeHostAccess(activeTab) {
    try {
      return await popupContext.hasPackageHostAccess(activeTab);
    } catch (error) {
      await recordIssue("bridge", "host-access-check-failed", error);
      return false;
    }
  }
  async function probeRuntimeHostAccess(activeTab) {
    if (RUNTIME_BROWSER !== "chromium" || !popupContext.isChatGPTTab(activeTab) || typeof chrome === "undefined" || !chrome.permissions) return null;
    try {
      return await chrome.permissions.contains({ origins: [popupContext.CHATGPT_ORIGIN] });
    } catch (error) {
      return { error: errorText(error) };
    }
  }
  async function backgroundHealth() {
    try {
      const result = await ext.runtime.sendMessage({ type: "cg-background-health" });
      if (!result || typeof result !== "object") return { ok: false, reason: "empty-response" };
      return result;
    } catch (error) {
      return { ok: false, reason: "runtime-message-failed", error: errorText(error) };
    }
  }


  function render(value) {
    setArchiveStatus("On demand", "off");
    if (value && Number.isFinite(Number(value.messageCount))) {
      summary.textContent = `${value.messageCount} messages captured for the last export action.`;
    } else {
      summary.textContent = "Nothing is backed up continuously. Export captures the current conversation only when you press a download button.";
    }
    buttons(true);
  }

  async function refresh() {
    render(null);
  }

  function downloadText(text, filename, type = "text/plain;charset=utf-8") {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function download(markdown, filename) {
    downloadText(markdown, filename || "chatgpt-conversation.md", "text/markdown;charset=utf-8");
  }

  async function exportChat(openNew) {
    feedback.textContent = "Capturing this conversation…";
    const activeTab = await popupContext.currentTab();
    if (!activeTab || activeTab.id == null || !popupContext.isChatGPTTab(activeTab)) {
      feedback.textContent = "Open a ChatGPT conversation before exporting.";
      return;
    }
    if (!IS_FIREFOX && !(await hasChromeHostAccess(activeTab))) {
      feedback.textContent = "Chrome has not granted GPT AntiCurse access to chatgpt.com. Use Save & reload first.";
      return;
    }
    let result;
    try {
      result = await ext.tabs.sendMessage(activeTab.id, { type: "cg-build-export-archive" });
      await clearPageBridgeIssue();
    } catch (error) {
      await recordIssue("bridge", "popup-page-bridge-failed", error, { export: true });
      feedback.textContent = `Could not capture this conversation: ${errorText(error)}`;
      return;
    }
    if (!result?.ok) {
      const reason = result?.reason || "No conversation snapshot returned";
      if (reason !== "archive-not-found") await recordIssue("archive", "export-failed", reason);
      feedback.textContent = `Export failed: ${reason}`;
      return;
    }
    const options = { id: result.conversationId, title: result.title, sourceUrl: result.sourceUrl };
    const archive = CGArchive.mergeArchiveWithRendered(result.baseArchive || null, result.rendered || [], options);
    if (!archive) {
      feedback.textContent = "Export failed: no conversation content was available.";
      return;
    }
    const markdown = CGArchiveExport.archiveToMarkdown(archive, { level: exportLevel.value });
    download(markdown, CGArchive.archiveFilename(archive));
    render(result.summary || CGArchive.archiveSummary(archive));
    feedback.textContent = result.authoritative
      ? `${exportLevel.options[exportLevel.selectedIndex].text} exported locally from the full conversation.`
      : `${exportLevel.options[exportLevel.selectedIndex].text} exported from partial fallback history; older technical detail may be missing.`;
    if (openNew) {
      await ext.tabs.create({ url: "https://chatgpt.com/" });
      window.close();
    }
  }

  function sanitizedTabUrl(activeTab) {
    if (!activeTab || typeof activeTab.url !== "string") return null;
    try {
      const url = new URL(activeTab.url);
      return `${url.origin}${url.pathname}`;
    } catch (error) {
      void error;
      return null;
    }
  }

  async function exportDebugReport() {
    feedback.textContent = "Collecting AntiCurse health state…";
    const activeTab = await popupContext.currentTab();
    const stored = await ext.storage.local.get({
      enabled: true,
      mode: "recent",
      maxDisplayMessages: 64,
      showGuardNotice: true,
      archiveExportLevel: "progress",
      cgTotals: null,
      cgLastIssue: null,
      cgIssueHistory: []
    });

    let page = null;
    let pageStats = null;
    if (activeTab && activeTab.id != null) {
      try {
        page = await ext.tabs.sendMessage(activeTab.id, { type: "cg-get-debug-state" });
      } catch (error) {
        page = { ok: false, error: errorText(error) };
      }
      try {
        pageStats = await ext.tabs.sendMessage(activeTab.id, { type: "cg-get-stats" });
      } catch (error) {
        pageStats = { ok: false, error: errorText(error) };
      }
    }

    const id = page?.state?.conversationId || popupContext.conversationIdFromTab(activeTab) || null;
    const archive = id ? { mode: "on-demand", persisted: false, conversationId: id } : null;

    let issueHistory = Array.isArray(stored.cgIssueHistory) ? stored.cgIssueHistory : [];
    if (diagnostics && typeof diagnostics.history === "function") issueHistory = await diagnostics.history();

    const report = {
      generatedAt: new Date().toISOString(),
      extension: {
        name: extensionManifest.name,
        version: extensionManifest.version,
        packageTarget: PACKAGE_TARGET,
        runtimeBrowser: RUNTIME_BROWSER,
        packageRuntimeMatch: PACKAGE_TARGET === RUNTIME_BROWSER,
        backgroundKind: BACKGROUND_KIND
      },
      browser: { userAgent: navigator.userAgent },
      backgroundHealth: await backgroundHealth(),
      activeTab: {
        present: !!activeTab,
        id: activeTab && Number.isInteger(activeTab.id) ? activeTab.id : null,
        url: sanitizedTabUrl(activeTab),
        isChatGPT: popupContext.isChatGPTTab(activeTab),
        chromeHostAccess: await probeRuntimeHostAccess(activeTab)
      },
      settings: {
        enabled: stored.enabled !== false,
        mode: stored.mode === "windowed-visible" ? "windowed-visible" : "recent",
        maxDisplayMessages: Number(stored.maxDisplayMessages) || 64,
        showGuardNotice: stored.showGuardNotice !== false,
          archiveMode: "on-demand",
        archiveExportLevel: stored.archiveExportLevel || "progress"
      },
      totals: stored.cgTotals || null,
      lastIssue: stored.cgLastIssue || null,
      issueHistory,
      pageStats,
      page,
      archiveSummary: archive
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadText(JSON.stringify(report, null, 2), `gpt-anticurse-debug-${stamp}.json`, "application/json;charset=utf-8");
    feedback.textContent = "Debug report downloaded. It contains health metadata and diagnostics, not conversation text.";
  }

  function runAction(label, action) {
    Promise.resolve().then(action).catch(async (error) => {
      console.error(`[GPT AntiCurse] ${label}`, error);
      await recordIssue("archive", "popup-action-failed", error, { action: label });
      feedback.textContent = `${label}: ${errorText(error)}`;
    });
  }

  ext.storage.local.get({ archiveExportLevel: "progress" }).then((saved) => {
    exportLevel.value = ["clean", "progress", "full"].includes(saved.archiveExportLevel) ? saved.archiveExportLevel : "progress";
    updateExportHelp();
    return refresh();
  }).catch((error) => {
    exportLevel.value = "progress";
    updateExportHelp();
    recordIssue("archive", "popup-settings-read-failed", error);
    feedback.textContent = `Backup settings could not be read: ${errorText(error)}`;
    render(null);
  });

  exportLevel.addEventListener("change", () => runAction("Saving export detail failed", async () => {
    updateExportHelp();
    await ext.storage.local.set({ archiveExportLevel: exportLevel.value });
  }));
  exportButton.addEventListener("click", () => runAction("Export failed", () => exportChat(false)));
  continueButton.addEventListener("click", () => runAction("Export/new chat failed", () => exportChat(true)));
  if (debugButton) debugButton.addEventListener("click", () => runAction("Debug report failed", exportDebugReport));
  buttons(false);
})();
