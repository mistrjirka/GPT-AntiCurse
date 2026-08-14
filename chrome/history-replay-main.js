/* Retain/replay Chromium history payloads across MAIN/ISOLATED startup races. */
(() => {
  "use strict";
  const CHANNEL = "__gpt_anticurse_v1__";
  let lastHistory;
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL) return;
    if (message.type === "history") lastHistory = message.history;
    else if (message.type === "history-request" && lastHistory !== undefined) {
      window.postMessage({ channel: CHANNEL, type: "history", history: lastHistory }, location.origin);
    } else if (message.type === "settings" && message.settings && typeof message.settings === "object") {
      if (message.settings.mode !== "recent" && message.settings.mode !== "windowed-visible") message.settings.mode = "recent";
    }
  });
})();
