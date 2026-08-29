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

  function terminalEmpty({
    observedRunning = false,
    latestRole = null,
    stopPresent = false,
    composerIdle = false,
    hasFinalOutput = false,
    hasIncompleteEvidence = false,
    attempted = false,
    stableMs = 0,
    graceMs = 750,
    retryCount = 0,
    retryLimit = 3
  } = {}) {
    const candidate = observedRunning === true &&
      latestRole === "assistant" &&
      stopPresent !== true &&
      composerIdle === true &&
      hasFinalOutput !== true &&
      hasIncompleteEvidence === true &&
      attempted !== true &&
      Number(retryCount) < Number(retryLimit);
    return {
      candidate,
      ready: candidate && Number(stableMs) >= Number(graceMs),
      capped: Number(retryCount) >= Number(retryLimit)
    };
  }

  globalThis.CGAntiCurseRecoveryPolicy = { settlement, recoveryVisible, terminalEmpty };
})();
