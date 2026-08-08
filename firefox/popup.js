"use strict";
const enabled = document.getElementById("enabled");
const limit = document.getElementById("limit");
const statsEl = document.getElementById("stats");
const modeInputs = Array.from(document.querySelectorAll('input[name="mode"]'));

browser.storage.local.get({ enabled: true, mode: "visible-history", maxDisplayMessages: 32 }).then((s) => {
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
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function save() {
  await browser.runtime.sendMessage({
    type: "cg-settings",
    enabled: enabled.checked,
    mode: selectedMode(),
    maxDisplayMessages: Number(limit.value)
  });
}

async function reload() {
  await save();
  const tab = await currentTab();
  if (tab && tab.id != null) await browser.tabs.reload(tab.id);
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
  const s = await browser.runtime.sendMessage({ type: "cg-get-stats", tabId: tab.id });
  if (!s) return;
  if (s.mode === "trimmed") {
    const roles = s.roleCountsBefore ? JSON.stringify(s.roleCountsBefore) : "n/a";
    statsEl.textContent =
      `Last response (${s.trimMode || "guard"}):\n` +
      `${s.mappingNodesBefore} → ${s.mappingNodesAfter} mapping nodes\n` +
      `${s.displayBefore} → ${s.displayAfter} display candidates\n` +
      `active-path roles: ${roles}\n` +
      `explicit hidden: ${s.explicitlyHiddenBefore || 0}\n` +
      `${s.originalBytes} → ${s.outputBytes} bytes\n` +
      `filter processing: ${s.processingMs} ms`;
  } else {
    statsEl.textContent = `Last response: ${s.mode}${s.reason ? ` (${s.reason})` : ""}${s.error ? `\n${s.error}` : ""}`;
  }
}).catch(() => {});
