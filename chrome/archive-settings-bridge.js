"use strict";
(() => {
  const CHANNEL = "__gpt_anticurse_v1__";
  function publish(archiveEnabled) {
    window.postMessage({ channel: CHANNEL, type: "archive-settings", archiveEnabled: archiveEnabled !== false }, location.origin);
  }
  chrome.storage.local.get({ archiveEnabled: true }).then((saved) => publish(saved.archiveEnabled)).catch(() => publish(true));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.archiveEnabled) publish(changes.archiveEnabled.newValue);
  });
})();
