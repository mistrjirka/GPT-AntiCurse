/* Ask the MAIN-world replay bridge for history after windowed.js is listening. */
(() => {
  "use strict";
  const CHANNEL = "__gpt_anticurse_v1__";
  const timers = [];
  let finished = false;

  function request() {
    if (finished) return;
    window.postMessage({ channel: CHANNEL, type: "history-request" }, location.origin);
  }

  function finish() {
    if (finished) return;
    finished = true;
    for (const timer of timers) clearTimeout(timer);
  }

  // Do not stop after the first history delivery. MAIN world can receive the
  // authoritative settings slightly before windowed.js finishes its own
  // storage read. In that ordering, the first archive arrives while the
  // isolated controller is still on its startup defaults. A later retained
  // replay lets the controller attach once its real Recent/Auto mode is known.
  // Equivalent snapshots are idempotent in windowed.js, so these bounded
  // replays cannot erase already-loaded pages.
  request();
  timers.push(setTimeout(request, 100));
  timers.push(setTimeout(request, 350));
  timers.push(setTimeout(request, 800));
  timers.push(setTimeout(request, 1600));
  timers.push(setTimeout(finish, 1800));
})();
