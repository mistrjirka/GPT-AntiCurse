/* Capture the full visible branch immediately before AntiCurse trims it. */
(() => {
  "use strict";
  const CHANNEL = "__gpt_anticurse_v1__";
  let enabled = true;

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel === CHANNEL && message.type === "archive-settings") {
      enabled = message.archiveEnabled !== false;
    }
  });

  const original = CGTrim.trimConversation;
  CGTrim.trimConversation = function antiCurseArchiveThenTrim(data, options) {
    if (enabled) {
      try {
        const archive = CGArchive.createArchive(data, { sourceUrl: location.href });
        if (archive) window.postMessage({ channel: CHANNEL, type: "archive", archive }, location.origin);
      } catch (_) {}
    }
    return original.call(this, data, options);
  };
})();
