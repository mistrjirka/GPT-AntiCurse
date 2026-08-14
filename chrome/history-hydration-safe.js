/* Prevent archived-history DOM from modifying ChatGPT's SSR tree before hydration settles. */
(function (global) {
  "use strict";

  const gate = global.CGAntiCurseDomReady;
  const base = global.CGHistoryOverlay;
  if (!gate || !base || typeof base.create !== "function") return;

  global.CGHistoryOverlay = {
    ...base,
    create(options) {
      const reader = base.create(options);
      const rawSetHistory = reader.setHistory.bind(reader);
      const rawSetMode = reader.setMode.bind(reader);
      const rawEnsureAttached = reader.ensureAttached.bind(reader);
      const rawLoadPreviousPage = reader.loadPreviousPage.bind(reader);
      const rawDestroy = reader.destroy.bind(reader);
      let pendingHistory = null;
      let hasPendingHistory = false;
      let pendingMode = null;

      function flush() {
        if (!gate.isReady()) return false;
        if (pendingMode !== null) {
          rawSetMode(pendingMode);
          pendingMode = null;
        }
        if (hasPendingHistory) {
          const value = pendingHistory;
          pendingHistory = null;
          hasPendingHistory = false;
          rawSetHistory(value);
          return true;
        }
        return false;
      }

      reader.setMode = (value) => {
        if (!gate.isReady()) {
          pendingMode = value;
          return;
        }
        rawSetMode(value);
      };

      reader.setHistory = (value) => {
        if (!gate.isReady()) {
          pendingHistory = value;
          hasPendingHistory = true;
          return;
        }
        rawSetHistory(value);
      };

      reader.ensureAttached = () => gate.isReady() ? rawEnsureAttached() : false;

      reader.loadPreviousPage = (optionsArg) => {
        if (!gate.isReady()) return { ok: false, reason: "hydration-pending", count: 0 };
        return rawLoadPreviousPage(optionsArg);
      };

      reader.destroy = () => {
        pendingHistory = null;
        hasPendingHistory = false;
        pendingMode = null;
        return rawDestroy();
      };

      gate.whenReady(() => {
        const applied = flush();
        if (applied) rawEnsureAttached();
      });

      return reader;
    }
  };
})(globalThis);
