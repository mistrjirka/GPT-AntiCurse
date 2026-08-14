/* Ask the MAIN-world replay bridge for history after windowed.js is listening. */
(() => {
  "use strict";
  const CHANNEL = "__gpt_anticurse_v1__";
  let resolved = false;
  const timers = [];

  function stop() {
    if (resolved) return;
    resolved = true;
    for (const timer of timers) clearTimeout(timer);
    window.removeEventListener("message", onMessage, true);
  }

  function onMessage(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message && message.channel === CHANNEL && message.type === "history") stop();
  }

  function request() {
    if (resolved) return;
    window.postMessage({ channel: CHANNEL, type: "history-request" }, location.origin);
  }

  // The listener is installed before the first request. If the conversation
  // response has not arrived yet, bounded retries cover that startup race, but
  // the first real/retained history delivery cancels every later replay so it
  // cannot reset already-loaded archived pages.
  window.addEventListener("message", onMessage, true);
  request();
  timers.push(setTimeout(request, 100));
  timers.push(setTimeout(request, 500));
  timers.push(setTimeout(request, 1500));
})();
