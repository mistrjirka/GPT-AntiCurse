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
  const toggle = document.getElementById("archiveEnabled");
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

  async function conversationId(activeTab, flush = false) {
    if (!activeTab || activeTab.id == null) return null;
    try {
      if (flush) {
        const saved = await ext.tabs.sendMessage(activeTab.id, { type: "cg-flush-archive" });
        await clearPageBridgeIssue();
        if (saved?.conversationId) return saved.conversationId;
        if (saved?.summary?.id) return saved.summary.id;
      }
      const result = await ext.tabs.sendMessage(activeTab.id, { type: "cg-get-conversation-id" });
      await clearPageBridgeIssue();
      return result?.conversationId || null;
    } catch (error) {
      if (!popupContext.isChatGPTTab(activeTab)) return null;
      if (!IS_FIREFOX && !(await hasChromeHostAccess(activeTab))) {
        feedback.textContent = "Chrome has not granted GPT AntiCurse access to chatgpt.com. Use Save & reload to grant access and reload the page.";
        return null;
      }
      if (flush) await recordIssue("bridge", "popup-page-bridge-failed", error, { flush: true });
      feedback.textContent = `ChatGPT page bridge is not running: ${errorText(error)}. Reload this tab after installing or updating AntiCurse.`;
      return null;
    }
  }

  function render(value) {
    if (!value) {
      setArchiveStatus(toggle.checked ? "No backup" : "Off", toggle.checked ? "missing" : "off");
      summary.textContent = toggle.checked
        ? "Reload this chat once to create a persistent local backup for export."
        : "Persistent backup is off. Current-tab history still works, but nothing is kept for export across reloads.";
      buttons(false);
      return;
    }
    const partial = value.complete === false;
    setArchiveStatus(partial ? "Partial" : "Ready", partial ? "partial" : "saved");
    const updated = value.updatedAt ? new Date(value.updatedAt).toLocaleString() : "unknown time";
    summary.textContent = partial
      ? `${value.messageCount} visible messages backed up locally · older history may be missing · Updated ${updated}`
      : `${value.messageCount} messages backed up locally · Updated ${updated}`;
    buttons(true);
  }

  async function refresh() {
    const activeTab = await popupContext.currentTab();
    const id = await conversationId(activeTab);
    if (!id) return render(null);
    const result = await ext.runtime.sendMessage({ type: "cg-get-archive-summary", conversationId: id });
    if (result?.ok) return render(result.summary);
    if (result?.reason !== "archive-not-found") await recordIssue("archive", "popup-summary-failed", result?.reason || "Archive summary failed");
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
    feedback.textContent = "Saving current turns…";
    const activeTab = await popupContext.currentTab();
    const id = await conversationId(activeTab, true);
    if (!id) {
      if (!feedback.textContent) feedback.textContent = "Could not reach a ChatGPT conversation in this tab.";
      return;
    }
    const result = await ext.runtime.sendMessage({ type: "cg-export-archive", conversationId: id, exportLevel: exportLevel.value });
    if (!result?.ok || !result.markdown) {
      const reason = result?.reason || "No Markdown returned";
      if (reason !== "archive-not-found") await recordIssue("archive", "export-failed", reason);
      feedback.textContent = reason === "archive-not-found"
        ? "No persistent backup is available yet. Enable backup and reload this chat once."
        : `Export failed: ${reason}`;
      return;
    }
    download(result.markdown, result.filename);
    render(result.summary);
    feedback.textContent = `${exportLevel.options[exportLevel.selectedIndex].text} exported locally.`;
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
      archiveEnabled: true,
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
    let archive = null;
    if (id) {
      try {
        const result = await ext.runtime.sendMessage({ type: "cg-get-archive-summary", conversationId: id });
        archive = result?.ok ? result.summary : { ok: false, reason: result?.reason || "no-response" };
      } catch (error) {
        archive = { ok: false, error: errorText(error) };
      }
    }

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
        archiveEnabled: stored.archiveEnabled !== false,
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

  ext.storage.local.get({ archiveEnabled: true, archiveExportLevel: "progress" }).then((saved) => {
    toggle.checked = saved.archiveEnabled !== false;
    exportLevel.value = ["clean", "progress", "full"].includes(saved.archiveExportLevel) ? saved.archiveExportLevel : "progress";
    updateExportHelp();
    return refresh();
  }).catch((error) => {
    toggle.checked = false;
    exportLevel.value = "progress";
    updateExportHelp();
    recordIssue("archive", "popup-settings-read-failed", error);
    feedback.textContent = `Backup settings could not be read: ${errorText(error)}`;
    render(null);
  });

  toggle.addEventListener("change", () => runAction("Changing backup setting failed", async () => {
    await ext.storage.local.set({ archiveEnabled: toggle.checked });
    if (toggle.checked) await conversationId(await popupContext.currentTab(), true);
    await refresh();
  }));
  exportLevel.addEventListener("change", () => runAction("Saving export detail failed", async () => {
    updateExportHelp();
    await ext.storage.local.set({ archiveExportLevel: exportLevel.value });
  }));
  exportButton.addEventListener("click", () => runAction("Export failed", () => exportChat(false)));
  continueButton.addEventListener("click", () => runAction("Export/new chat failed", () => exportChat(true)));
  if (debugButton) debugButton.addEventListener("click", () => runAction("Debug report failed", exportDebugReport));
  buttons(false);
})();
