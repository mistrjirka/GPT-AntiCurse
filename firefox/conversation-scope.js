/* Shared page-lifetime guard for ChatGPT SPA conversation boundaries. */
(function (global) {
  "use strict";

  function currentConversationId() {
    if (typeof location === "undefined" || !location) return null;
    const match = String(location.pathname || "").match(/(?:^|\/)c\/([^/?#]+)/);
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch (_) {
      return null;
    }
  }

  function create(options = {}) {
    const getId = typeof options.getId === "function" ? options.getId : currentConversationId;
    let id = getId();
    let generation = 0;

    function sync() {
      const next = getId();
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
