/* Shared page-lifetime guard for ChatGPT SPA conversation boundaries. */
(function (global) {
  "use strict";

  function defaultUrl() {
    // Chromium isolated worlds expose page globals such as `location` through
    // lexical host bindings even when the `globalThis` proxy does not surface
    // the same property. Use that binding first; the explicit global fallback
    // keeps this helper usable in unit/non-DOM contexts too.
    if (typeof location !== "undefined" && location && location.href) return location.href;
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
