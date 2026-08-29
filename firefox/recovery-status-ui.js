/* Pure presentation policy. content.js is the sole badge DOM owner. */
(() => {
  "use strict";

  function countdown(value) {
    const seconds = Math.max(0, Math.ceil((Number(value) || 0) / 1000));
    if (seconds === 0) return "now";
    if (seconds >= 60) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    return `${seconds}s`;
  }

  function scheduledPresentation(remainingMs) {
    if (remainingMs == null) return { text: "watching", title: "Auto-Continue is watching this response." };
    const when = countdown(remainingMs);
    if (when === "now") return { text: "continue now", title: "Auto-Continue is checking this response now because it has not progressed." };
    return { text: `continue in ${when}`, title: `Auto-Continue will check this response in ${when} if it does not progress.` };
  }

  function presentation(value) {
    if (!value || value.active !== true) return null;
    switch (value.phase) {
      case "blocked-pro": return { text: "off for Pro", title: "Auto-Continue is disabled for Pro runs." };
      case "blocked-unknown": return { text: "waiting for model", title: "Auto-Continue is waiting until the current model can be identified safely." };
      case "loading": return scheduledPresentation(value.remainingMs);
      case "paused-draft": return { text: "paused · draft present", title: "Auto-Continue is paused because there is text or an attachment in the composer." };
      case "checking": return { text: "checking stall", title: "Auto-Continue detected a possible stall and is verifying it." };
      case "stopping": return { text: "stopping", title: "Auto-Continue is stopping the stalled response." };
      case "settling": return { text: "stopped · preparing", title: "The response is stopped; Auto-Continue is waiting briefly for ChatGPT's composer to become stable." };
      case "sending": return { text: "continuing", title: "Auto-Continue is preparing the continuation message." };
      case "confirming": return { text: "starting…", title: "The continuation was sent; Auto-Continue is waiting for the new response to start." };
      case "reloading": return { text: "reloading", title: "Auto-Continue is reloading the conversation because the stopped run did not become usable." };
      case "restoring": return { text: "resuming", title: "Auto-Continue is resuming the same recovery transaction after reload." };
      default: return value.longWaitBanner
        ? { text: "stall detected", title: "ChatGPT reported an unusually long wait; Auto-Continue is starting recovery." }
        : scheduledPresentation(value.remainingMs);
    }
  }

  globalThis.CGAntiCurseRecoveryStatusUi = { countdown, presentation };
})();
