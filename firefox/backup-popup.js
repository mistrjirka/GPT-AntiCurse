"use strict";
(() => {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const diagnostics = globalThis.CGAntiCurseDiagnostics;
  const toggle = document.getElementById("archiveEnabled");
  const status = document.getElementById("archiveStatus");
  const summary = document.getElementById("archiveSummary");
  const exportLevel = document.getElementById("archiveExportLevel");
  const exportHelp = document.getElementById("archiveExportHelp");
  const exportButton = document.getElementById("exportMarkdown");
  const continueButton = document.getElementById("continueChat");
  const feedback = document.getElementById("feedback");
  const EXPORT_HELP = {
    clean: "Tasks and final answers only",
    progress: "Also visible progress and a checklist",
    full: "Also exact tool calls and plan payloads"
  };

  function buttons(on) { exportButton.disabled = !on; continueButton.disabled = !on; }
  function setArchiveStatus(text, state) { status.textContent = text; status.dataset.state = state; }
  function updateExportHelp() { exportHelp.textContent = EXPORT_HELP[exportLevel.value] || EXPORT_HELP.progress; }
  function errorText(error) { return String(error && error.message ? error.message : error || "Unknown error"); }
  function recordIssue(code, error, extra) {
    if (diagnostics && typeof diagnostics.record === "function") return diagnostics.record("archive", code, error, extra);
    console.warn(`[GPT AntiCurse] archive/${code}`, error, extra || "");
    return Promise.resolve(null);
  }
  async function tab() { return (await ext.tabs.query({ active: true, currentWindow: true }))[0]; }
  function isChatGPTTab(activeTab) { return !!(activeTab && typeof activeTab.url === "string" && /^https:\/\/chatgpt\.com\//.test(activeTab.url)); }

  async function conversationId(activeTab, flush = false) {
    if (!activeTab || activeTab.id == null) return null;
    try {
      if (flush) {
        const saved = await ext.tabs.sendMessage(activeTab.id, { type: "cg-flush-archive" });
        if (saved?.conversationId) return saved.conversationId;
        if (saved?.summary?.id) return saved.summary.id;
      }
      const result = await ext.tabs.sendMessage(activeTab.id, { type: "cg-get-conversation-id" });
      return result?.conversationId || null;
    } catch (error) {
      if (isChatGPTTab(activeTab)) await recordIssue("popup-page-bridge-failed", error, { flush });
      return null;
    }
  }

  function render(value) {
    if (!value) {
      setArchiveStatus(toggle.checked ? "Not saved" : "Off", toggle.checked ? "missing" : "off");
      summary.textContent = toggle.checked
        ? "Open or reload a ChatGPT conversation to create its optional persistent backup."
        : "Persistent backup is off. On-page history loading still works for the current tab.";
      buttons(false);
      return;
    }
    setArchiveStatus(value.complete === false ? "Partial" : "Saved", value.complete === false ? "partial" : "saved");
    const updated = value.updatedAt ? new Date(value.updatedAt).toLocaleString() : "unknown time";
    summary.textContent = `${value.messageCount} turns · ${value.characters} chars · ${updated}`;
    buttons(true);
  }

  async function refresh() {
    const activeTab = await tab();
    const id = await conversationId(activeTab);
    if (!id) return render(null);
    const result = await ext.runtime.sendMessage({ type: "cg-get-archive-summary", conversationId: id });
    if (result?.ok) return render(result.summary);
    if (result?.reason !== "archive-not-found") await recordIssue("popup-summary-failed", result?.reason || "Archive summary failed");
    render(null);
  }

  function download(markdown, filename) {
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename || "chatgpt-conversation.md";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportChat(openNew) {
    feedback.textContent = "Saving current turns…";
    const activeTab = await tab();
    const id = await conversationId(activeTab, true);
    if (!id) {
      feedback.textContent = "Could not reach a ChatGPT conversation in this tab.";
      return;
    }
    const result = await ext.runtime.sendMessage({
      type: "cg-export-archive",
      conversationId: id,
      exportLevel: exportLevel.value
    });
    if (!result?.ok || !result.markdown) {
      const reason = result?.reason || "No Markdown returned";
      if (reason !== "archive-not-found") await recordIssue("export-failed", reason);
      feedback.textContent = reason === "archive-not-found"
        ? "No persistent backup is available yet. Enable backup and reload this chat once."
        : `Export failed: ${reason}`;
      return;
    }
    download(result.markdown, result.filename);
    render(result.summary);
    feedback.textContent = `${exportLevel.options[exportLevel.selectedIndex].text} Markdown exported locally.`;
    if (openNew) {
      await ext.tabs.create({ url: "https://chatgpt.com/" });
      window.close();
    }
  }

  function runAction(label, action) {
    Promise.resolve().then(action).catch(async (error) => {
      console.error(`[GPT AntiCurse] ${label}`, error);
      await recordIssue("popup-action-failed", error, { action: label });
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
    recordIssue("popup-settings-read-failed", error);
    feedback.textContent = `Backup settings could not be read: ${errorText(error)}`;
    render(null);
  });

  toggle.addEventListener("change", () => runAction("Changing backup setting failed", async () => {
    await ext.storage.local.set({ archiveEnabled: toggle.checked });
    if (toggle.checked) await conversationId(await tab(), true);
    await refresh();
  }));
  exportLevel.addEventListener("change", () => runAction("Saving export detail failed", async () => {
    updateExportHelp();
    await ext.storage.local.set({ archiveExportLevel: exportLevel.value });
  }));
  exportButton.addEventListener("click", () => runAction("Export failed", () => exportChat(false)));
  continueButton.addEventListener("click", () => runAction("Export/new chat failed", () => exportChat(true)));
  buttons(false);
})();
