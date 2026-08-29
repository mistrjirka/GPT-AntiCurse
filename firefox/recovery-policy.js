/* Pure Auto-Continue state policy shared by the runtime and contract tests. */
(() => {
  "use strict";

  function settlement({ stopPresent, composerIdle, uiSettledMs = 0, uiGraceMs = 750 } = {}) {
    const uiReady = !stopPresent && composerIdle === true;
    if (uiReady && Number(uiSettledMs) >= Number(uiGraceMs)) {
      return { settled: true, source: "ui", uiReady };
    }
    return { settled: false, source: null, uiReady };
  }

  function recoveryVisible({ transactionActive = false, liveTurnPresent = false, shellLoading = false } = {}) {
    return transactionActive || shellLoading || liveTurnPresent;
  }

  globalThis.CGAntiCurseRecoveryPolicy = { settlement, recoveryVisible };
})();
