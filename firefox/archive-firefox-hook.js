/* Capture the full visible branch immediately before AntiCurse trims it. */
(() => {
  "use strict";
  let enabled = true;
  browser.storage.local.get({ archiveEnabled: true }).then((saved) => {
    enabled = saved.archiveEnabled !== false;
  }).catch(() => {});
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.archiveEnabled) enabled = changes.archiveEnabled.newValue !== false;
  });

  const original = CGTrim.trimConversation;
  CGTrim.trimConversation = function antiCurseArchiveThenTrim(data, options) {
    if (enabled) {
      try {
        const archive = CGArchive.createArchive(data);
        if (archive) CGArchiveBackground.saveNetworkArchive(archive, -1).catch(() => {});
      } catch (_) {}
    }
    return original.call(this, data, options);
  };
})();
