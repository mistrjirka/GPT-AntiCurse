/* Defaults for new installs and legacy history modes. */
(() => {
  "use strict";
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const diagnostics = globalThis.CGAntiCurseDiagnostics;

  ext.storage.local.get(["maxDisplayMessages", "archiveExportLevel", "mode"]).then((saved) => {
    const updates = {};
    if (saved.maxDisplayMessages == null) updates.maxDisplayMessages = 64;
    if (saved.archiveExportLevel == null) updates.archiveExportLevel = "progress";
    if (saved.mode !== "recent" && saved.mode !== "windowed-visible") updates.mode = "recent";
    if (Object.keys(updates).length) return ext.storage.local.set(updates);
    return undefined;
  }).catch((error) => {
    if (diagnostics && typeof diagnostics.record === "function") {
      diagnostics.record("settings", "defaults-init-failed", error);
    } else {
      console.error("[GPT AntiCurse] Failed to initialize extension defaults", error);
    }
  });
})();
