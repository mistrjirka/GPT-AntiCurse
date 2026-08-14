/* Delay extension-owned DOM until ChatGPT has finished its initial document load/hydration work. */
(function (global) {
  "use strict";

  let ready = false;
  let resolveReady;
  const readyPromise = new Promise((resolve) => { resolveReady = resolve; });

  function finish() {
    if (ready) return;
    ready = true;
    resolveReady();
  }

  function settleAfterLoad() {
    // Give React two paint opportunities, then wait for an idle slice. The
    // timeout keeps the extension usable even if ChatGPT remains continuously
    // busy after load.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (typeof requestIdleCallback === "function") requestIdleCallback(finish, { timeout: 1000 });
      else setTimeout(finish, 0);
    }));
  }

  if (document.readyState === "complete") settleAfterLoad();
  else window.addEventListener("load", settleAfterLoad, { once: true });

  global.CGAntiCurseDomReady = {
    isReady() { return ready; },
    whenReady(callback) {
      if (typeof callback === "function") readyPromise.then(callback);
      return readyPromise;
    }
  };
})(globalThis);
