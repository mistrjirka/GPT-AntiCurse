"use strict";
const enabled = document.getElementById("enabled");
const limit = document.getElementById("limit");
const statsEl = document.getElementById("stats");
const modeInputs = Array.from(document.querySelectorAll('input[name="mode"]'));

chrome.storage.local.get({ enabled: true, mode: "visible-history", maxDisplayMessages: 32 }).then((s) => {
  enabled.checked = s.enabled;
  limit.value = s.maxDisplayMessages;
  const selected = modeInputs.find((x) => x.value === s.mode) || modeInputs[0];
  selected.checked = true;
});

function selectedMode() {
  const selected = modeInputs.find((x) => x.checked);
  return selected ? selected.value : "visible-history";
}

async function currentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function save() {
  await chrome.storage.local.set({
    enabled: enabled.checked,
    mode: selectedMode(),
    maxDisplayMessages: Math.max(4, Math.min(500, Number(limit.value) || 32))
  });
}

async function reload() {
  await save();
  const tab = await currentTab();
  if (tab && tab.id != null) await chrome.tabs.reload(tab.id);
  window.close();
}

document.getElementById("reload").addEventListener("click", reload);
document.getElementById("full").addEventListener("click", async () => {
  enabled.checked = false;
  await reload();
});

enabled.addEventListener("change", save);
limit.addEventListener("change", save);
for (const input of modeInputs) input.addEventListener("change", save);

currentTab().then(async (tab) => {
  if (!tab || tab.id == null) return;
  try {
    const s = await chrome.tabs.sendMessage(tab.id, { type: "cg-get-stats" });
    if (!s) return;
    if (s.mode === "trimmed") {
      const roles = s.roleCountsBefore ? JSON.stringify(s.roleCountsBefore) : "n/a";
      statsEl.textContent =
        `Last response (${s.trimMode || "guard"}):\n` +
        `${s.mappingNodesBefore} → ${s.mappingNodesAfter} mapping nodes\n` +
        `${s.displayBefore} → ${s.displayAfter} display candidates\n` +
        `active-path roles: ${roles}\n` +
        `explicit hidden: ${s.explicitlyHiddenBefore || 0}\n` +
        `transport: ${s.transport || "Chromium"}\n` +
        `processing: ${s.processingMs} ms`;
    } else {
      statsEl.textContent = `Last response: ${s.mode}${s.reason ? ` (${s.reason})` : ""}${s.error ? `\n${s.error}` : ""}`;
    }
  } catch (_) {}
});
