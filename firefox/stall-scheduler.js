/* Background alarm backup for stalled-run deadlines in throttled/hidden tabs. */
(() => {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const PREFIX = "cg-stall-alarm:";

  function alarmName(tabId) { return `${PREFIX}${tabId}`; }
  function tabIdFromAlarm(name) {
    if (typeof name !== "string" || !name.startsWith(PREFIX)) return null;
    const value = Number(name.slice(PREFIX.length));
    return Number.isInteger(value) && value >= 0 ? value : null;
  }

  function quietPromise(value) {
    if (value && typeof value.catch === "function") value.catch((error) => console.debug("[GPT AntiCurse] stall alarm operation failed", error));
  }

  ext.runtime.onMessage.addListener((message, sender) => {
    if (!message || (message.type !== "cg-stall-alarm-schedule" && message.type !== "cg-stall-alarm-clear")) return undefined;
    const tabId = sender && sender.tab && sender.tab.id;
    if (!Number.isInteger(tabId)) return undefined;
    const name = alarmName(tabId);

    if (message.type === "cg-stall-alarm-clear") {
      try { quietPromise(ext.alarms.clear(name)); } catch { /* tab teardown */ }
      return undefined;
    }

    const dueAt = Number(message.dueAt);
    if (!Number.isFinite(dueAt)) return undefined;
    try {
      // Creating an alarm with the same name atomically replaces the old
      // deadline, so every progress event moves the background wake-up too.
      ext.alarms.create(name, { when: Math.max(Date.now(), dueAt) });
    } catch { /* local content timer remains as fallback */ }
    return undefined;
  });

  ext.alarms.onAlarm.addListener((alarm) => {
    const tabId = tabIdFromAlarm(alarm && alarm.name);
    if (tabId == null) return;
    try {
      quietPromise(ext.tabs.sendMessage(tabId, {
        type: "cg-stall-alarm-fire",
        scheduledTime: Number(alarm.scheduledTime) || Date.now()
      }));
    } catch { /* tab may have closed */ }
  });

  if (ext.tabs && ext.tabs.onRemoved) {
    ext.tabs.onRemoved.addListener((tabId) => {
      try { quietPromise(ext.alarms.clear(alarmName(tabId))); } catch { /* ignore */ }
    });
  }
})();
