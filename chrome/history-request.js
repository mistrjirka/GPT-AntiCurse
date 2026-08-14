/* Ask the MAIN-world replay bridge for history after windowed.js is listening. */
(() => {
  "use strict";
  const CHANNEL = "__gpt_anticurse_v1__";
  function request() { window.postMessage({ channel: CHANNEL, type: "history-request" }, location.origin); }
  request();
  setTimeout(request, 100);
  setTimeout(request, 500);
})();
