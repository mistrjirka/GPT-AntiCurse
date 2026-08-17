/* Shared page-lifetime guard for ChatGPT SPA conversation boundaries. */
(function (global) {
  "use strict";

  function defaultUrl() {
    // In Chromium extension isolated worlds, the Window proxy exposed as
    // `globalThis` may not reliably surface `location`, while document.location
    // still refers to the page URL. Keep the fallback for unit/non-DOM contexts.
    if (global.document && global.document.location) return global.document.location.href;
    return global.location && global.location.href;
  }

  function create(options = {}) {
    const getUrl = typeof options.getUrl === "function" ? options.getUrl : defaultUrl;
    const parseId = typeof options.parseId === "function"
      ? options.parseId
      : (url) => global.CGArchive && typeof global.CGArchive.conversationIdFromUrl === "function"
        ? global.CGArchive.conversationIdFromUrl(url)
        : null;

    let id = parseId(getUrl());
    let generation = 0;

    function sync() {
      const next = parseId(getUrl());
      if (next === id) return false;
      id = next;
      generation++;
      return true;
    }

    function snapshot() {
      sync();
      return { id, generation };
    }

    function isCurrent(token) {
      sync();
      return !!token && token.id === id && token.generation === generation;
    }

    return {
      sync,
      snapshot,
      isCurrent,
      currentId() {
        sync();
        return id;
      }
    };
  }

  global.CGConversationScope = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = global.CGConversationScope;
})(typeof globalThis !== "undefined" ? globalThis : this);
