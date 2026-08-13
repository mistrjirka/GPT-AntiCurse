/* Defaults for new installations. Existing explicit user choices are preserved. */
(() => {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  ext.storage.local.get(["maxDisplayMessages", "archiveExportLevel"]).then((saved) => {
    const updates = {};
    if (saved.maxDisplayMessages == null) updates.maxDisplayMessages = 64;
    if (saved.archiveExportLevel == null) updates.archiveExportLevel = "progress";
    if (Object.keys(updates).length) return ext.storage.local.set(updates);
  }).catch(() => {});
})();
