"use strict";

const enabled = document.getElementById("enabled");
const limit = document.getElementById("limit");

function addModeBeforeRecent(value, title, description) {
  const recent = document.querySelector('input[name="mode"][value="recent"]')?.closest("label.mode");
  if (!recent || document.querySelector(`input[name="mode"][value="${value}"]`)) return;
  const label = document.createElement("label");
  label.className = "mode";
  const input = document.createElement("input");
  input.type = "radio"; input.name = "mode"; input.value = value;
  const copy = document.createElement("span");
  const bold = document.createElement("b"); bold.textContent = title;
  const small = document.createElement("small"); small.textContent = description;
  copy.append(bold, small); label.append(input, copy); recent.before(label);
}

addModeBeforeRecent("latest-visible", "Latest visible only", "Newest N visible user/assistant turns only; hidden/tool nodes do not consume the window.");
addModeBeforeRecent("windowed-visible", "Auto windowed history (experimental)", "Newest N stay native; older visible turns load on scroll-up and distant injected turns unload again.");
const limitLabel = document.querySelector(".limit-row span");
if (limitLabel) limitLabel.textContent = "Visible-turn window";
const how = document.querySelector(".how");
if (how) how.append(" Auto windowed history keeps a small native window and virtualizes older visible turns as you scroll.");

const modeInputs = Array.from(document.querySelectorAll('input[name="mode"]'));
const nf = new Intl.NumberFormat();

const EMPTY_TOTALS = {
  responsesTrimmed: 0,
  nodesRemoved: 0,
  nodesDelivered: 0,
  visibleTurnsKept: 0,
  inputBytes: 0,
  outputBytes: 0,
  bytesRemoved: 0
};

function fmt(n) {
  const value = Number(n);
  return nf.format(Number.isFinite(value) ? value : 0);
}

function fmtBytes(n) {
  let value = Math.max(0, Number(n) || 0);
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

function selectedMode() {
  const selected = modeInputs.find((x) => x.checked);
  return selected ? selected.value : "visible-history";
}

function updateLimitState() {
  limit.disabled = selectedMode() === "visible-history";
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

function renderTotals(totals) {
  const t = { ...EMPTY_TOTALS, ...(totals || {}) };
  document.getElementById("totalRemoved").textContent = fmt(t.nodesRemoved);
  document.getElementById("totalResponses").textContent = fmt(t.responsesTrimmed);
  document.getElementById("totalBytes").textContent = fmtBytes(t.bytesRemoved);
}

function setStatus(text, kind) {
  const pill = document.getElementById("statusPill");
  pill.textContent = text;
  pill.className = `status-pill${kind ? ` ${kind}` : ""}`;
}

function renderStats(s) {
  if (!s) {
    setStatus("Waiting", "");
    return;
  }

  if (s.mode === "trimmed") {
    const before = Math.max(0, Number(s.mappingNodesBefore) || 0);
    const after = Math.max(0, Number(s.mappingNodesAfter) || 0);
    const removed = Math.max(0, Number(s.discardedNodes) || (before - after));
    const saved = before ? Math.max(0, Math.min(100, (removed / before) * 100)) : 0;
    const visible = Math.max(0, Number(s.displayAfter) || 0);

    document.getElementById("savedPct").textContent = saved >= 99.5 ? saved.toFixed(1) : Math.round(saved);
    document.getElementById("savedBar").style.width = `${saved}%`;
    document.getElementById("nodeFlow").textContent = `${fmt(before)} → ${fmt(after)}`;
    document.getElementById("removedNodes").textContent = fmt(removed);
    document.getElementById("visibleKept").textContent = fmt(visible);

    if (Number.isFinite(Number(s.originalBytes)) && Number.isFinite(Number(s.outputBytes))) {
      const byteRemoved = Math.max(0, Number(s.originalBytes) - Number(s.outputBytes));
      const bytePct = Number(s.originalBytes) > 0 ? (byteRemoved / Number(s.originalBytes)) * 100 : 0;
      document.getElementById("bytesSaved").textContent = `${fmtBytes(byteRemoved)} (${Math.round(bytePct)}%)`;
    } else {
      document.getElementById("bytesSaved").textContent = "not measured";
    }
    document.getElementById("processing").textContent = Number.isFinite(Number(s.processingMs)) ? `${s.processingMs} ms` : "—";
    setStatus("Active", "active");
  } else if (s.mode === "error") {
    document.getElementById("nodeFlow").textContent = "Original response kept";
    document.getElementById("processing").textContent = "error";
    setStatus("Error", "error");
  } else {
    document.getElementById("savedPct").textContent = "0";
    document.getElementById("savedBar").style.width = "0%";
    document.getElementById("nodeFlow").textContent = "No trimming needed";
    setStatus("Ready", "active");
  }
}

chrome.storage.local.get({ enabled: true, mode: "visible-history", maxDisplayMessages: 32, cgTotals: EMPTY_TOTALS }).then((s) => {
  enabled.checked = s.enabled;
  limit.value = s.maxDisplayMessages;
  const selected = modeInputs.find((x) => x.value === s.mode) || modeInputs[0];
  selected.checked = true;
  updateLimitState();
  renderTotals(s.cgTotals);
});

document.getElementById("reload").addEventListener("click", reload);
document.getElementById("full").addEventListener("click", async () => {
  enabled.checked = false;
  await reload();
});
document.getElementById("resetTotals").addEventListener("click", async () => {
  const totals = await chrome.runtime.sendMessage({ type: "cg-reset-totals" });
  renderTotals(totals);
});

enabled.addEventListener("change", save);
limit.addEventListener("change", save);
for (const input of modeInputs) input.addEventListener("change", () => { updateLimitState(); save(); });

currentTab().then(async (tab) => {
  if (!tab || tab.id == null) return;
  try {
    const s = await chrome.tabs.sendMessage(tab.id, { type: "cg-get-stats" });
    renderStats(s);
  } catch (_) {}
});
