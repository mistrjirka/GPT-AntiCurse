/* Default visible window for new installations. */
(() => {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  ext.storage.local.get("maxDisplayMessages").then((saved) => {
    if (saved.maxDisplayMessages == null) return ext.storage.local.set({ maxDisplayMessages: 64 });
  }).catch(() => {});
})();
