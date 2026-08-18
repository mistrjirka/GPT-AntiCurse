/* Compose the archived-history renderer from named modules. */
(function (global) {
  "use strict";

  let overlay = global.CGHistoryVirtualized;
  if (!overlay || typeof overlay.create !== "function") return;

  const fidelity = global.CGHistoryFidelity;
  if (fidelity && typeof fidelity.wrap === "function") overlay = fidelity.wrap(overlay);

  const hydration = global.CGHistoryHydration;
  if (hydration && typeof hydration.wrap === "function") {
    overlay = hydration.wrap(overlay, global.CGAntiCurseDomReady);
  }

  global.CGHistoryOverlay = overlay;
})(globalThis);
