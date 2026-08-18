/* Defer archived-history DOM changes until ChatGPT hydration settles. */
(function (global) {
  "use strict";

  function wrap(base, gate = global.CGAntiCurseDomReady) {
    if (!gate || !base || typeof base.create !== "function") return base;

    return {
      ...base,
      create(options) {
        const reader = base.create(options);
        const setHistory = reader.setHistory.bind(reader);
        const setMode = reader.setMode.bind(reader);
        const ensureAttached = reader.ensureAttached.bind(reader);
        const loadPreviousPage = reader.loadPreviousPage.bind(reader);
        const destroy = reader.destroy.bind(reader);
        let pendingHistory = null;
        let hasPendingHistory = false;
        let pendingMode = null;

        function flush() {
          if (!gate.isReady()) return false;
          if (pendingMode !== null) {
            setMode(pendingMode);
            pendingMode = null;
          }
          if (!hasPendingHistory) return false;
          const value = pendingHistory;
          pendingHistory = null;
          hasPendingHistory = false;
          setHistory(value);
          return true;
        }

        reader.setMode = (value) => {
          if (!gate.isReady()) {
            pendingMode = value;
            return;
          }
          setMode(value);
        };

        reader.setHistory = (value) => {
          if (!gate.isReady()) {
            pendingHistory = value;
            hasPendingHistory = true;
            return;
          }
          setHistory(value);
        };

        reader.ensureAttached = () => gate.isReady() ? ensureAttached() : false;
        reader.loadPreviousPage = (optionsArg) => gate.isReady()
          ? loadPreviousPage(optionsArg)
          : { ok: false, reason: "hydration-pending", count: 0 };

        reader.destroy = () => {
          pendingHistory = null;
          hasPendingHistory = false;
          pendingMode = null;
          return destroy();
        };

        gate.whenReady(() => {
          if (flush()) ensureAttached();
        });

        return reader;
      }
    };
  }

  global.CGHistoryHydration = { wrap };
})(globalThis);
