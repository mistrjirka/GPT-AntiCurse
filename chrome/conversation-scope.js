/* Shared page-lifetime guard for ChatGPT SPA conversation boundaries. */
(function (global) {
  "use strict";

  function defaultConversationId() {
    // Chromium isolated worlds reliably expose page globals through lexical host
    // bindings. Avoid reading browser-owned properties through the globalThis
    // proxy; extension-owned test contexts can inject getId/getUrl instead.
    if (typeof CGArchive !== "undefined" &&
        CGArchive && typeof CGArchive.conversationIdFromUrl === "function" &&
        typeof location !== "undefined" && location) {
      return CGArchive.conversationIdFromUrl(location.href);
    }
    return null;
  }

  function create(options = {}) {
    let getId;
    if (typeof options.getId === "function") {
      getId = options.getId;
    } else if (typeof options.getUrl === "function") {
      const parseId = typeof options.parseId === "function"
        ? options.parseId
        : (url) => global.CGArchive && typeof global.CGArchive.conversationIdFromUrl === "function"
          ? global.CGArchive.conversationIdFromUrl(url)
          : null;
      getId = () => parseId(options.getUrl());
    } else {
      getId = defaultConversationId;
    }

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
