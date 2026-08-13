"use strict";

(() => {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const toggle = document.getElementById("archiveEnabled");
  const status = document.getElementById("archiveStatus");
  const summary = document.getElementById("archiveSummary");
  const exportButton = document.getElementById("exportMarkdown");
  const continueButton = document.getElementById("continueChat");
  const feedback = document.getElementById("feedback");

  function buttons(on) { exportButton.disabled = !on; continueButton.disabled = !on; }
  async function tab() { return (await ext.tabs.query({ active: true, currentWindow: true }))[0]; }
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
    } catch (_) { return null; }
  }
  function render(value) {
    if (!value) {
      status.textContent = toggle.checked ? "Not saved" : "Off";
      summary.textContent = "Open or reload a ChatGPT conversation to create its local backup.";
      buttons(false);
      return;
    }
    status.textContent = value.complete === false ? "Partial" : "Saved";
    const updated = value.updatedAt ? new Date(value.updatedAt).toLocaleString() : "unknown time";
    summary.textContent = `${value.messageCount} turns · ${value.characters} chars · ${updated}`;
    buttons(true);
  }
  async function refresh() {
    const activeTab = await tab();
    const id = await conversationId(activeTab);
    if (!id) return render(null);
    const result = await ext.runtime.sendMessage({ type: "cg-get-archive-summary", conversationId: id });
    render(result?.ok ? result.summary : null);
  }
  function download(markdown, filename) {
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "chatgpt-conversation.md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function exportChat(openNew) {
    feedback.textContent = "Saving current turns…";
    const activeTab = await tab();
    const id = await conversationId(activeTab, true);
    if (!id) { feedback.textContent = "Open a ChatGPT conversation first."; return; }
    const result = await ext.runtime.sendMessage({ type: "cg-export-archive", conversationId: id });
    if (!result?.ok || !result.markdown) {
      feedback.textContent = "No local backup is available yet. Reload this chat once and try again.";
      return;
    }
    download(result.markdown, result.filename);
    render(result.summary);
    feedback.textContent = "Markdown exported locally.";
    if (openNew) { await ext.tabs.create({ url: "https://chatgpt.com/" }); window.close(); }
  }
  ext.storage.local.get({ archiveEnabled: true }).then((saved) => {
    toggle.checked = saved.archiveEnabled !== false;
    refresh().catch(() => render(null));
  });
  toggle.addEventListener("change", async () => {
    await ext.storage.local.set({ archiveEnabled: toggle.checked });
    if (toggle.checked) await conversationId(await tab(), true);
    await refresh();
  });
  exportButton.addEventListener("click", () => exportChat(false).catch(() => { feedback.textContent = "Export failed."; }));
  continueButton.addEventListener("click", () => exportChat(true).catch(() => { feedback.textContent = "Export failed."; }));
  buttons(false);
})();
