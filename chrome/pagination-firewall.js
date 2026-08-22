/* Pure ChatGPT native-pagination limiter. */
(function (global) {
  "use strict";

  function mappingObject(data) {
    const mapping = data && data.mapping;
    return !!mapping && typeof mapping === "object" && !Array.isArray(mapping);
  }

  function cursorValue(data) {
    return typeof data?.cursor === "string" && data.cursor.trim() ? data.cursor.trim() : null;
  }

  function isCursorRequest(urlString) {
    try {
      const url = new URL(urlString, "https://chatgpt.com/");
      return url.searchParams.has("cursor");
    } catch {
      return false;
    }
  }

  function apply(data, options = {}) {
    if (!mappingObject(data)) {
      return { changed: false, data, reason: "unsupported-shape", remoteCursor: null, stats: {} };
    }

    const mappingNodesBefore = Object.keys(data.mapping).length;
    const remoteCursor = cursorValue(data);
    if (options.cursorRequest === true) {
      return {
        changed: true,
        data: { ...data, mapping: {}, cursor: null },
        reason: "older-page-blocked",
        remoteCursor,
        stats: {
          paginationFirewall: true,
          paginationOlderPageBlocked: true,
          paginationCursorSuppressed: !!remoteCursor,
          paginationBlockedNodes: mappingNodesBefore,
          mappingNodesBefore,
          mappingNodesAfter: 0,
          discardedNodes: mappingNodesBefore,
          displayAfter: 0,
          currentNodePreserved: true
        }
      };
    }

    // Initial conversation pages must have the same active-node invariant used
    // by the trimmer. A mapping-like but unfamiliar shape is left untouched.
    const currentId = data && data.current_node;
    if (!currentId || !data.mapping[currentId]) {
      return { changed: false, data, reason: "unsupported-shape", remoteCursor, stats: {} };
    }

    if (!remoteCursor) {
      return { changed: false, data, reason: "no-cursor", remoteCursor: null, stats: {} };
    }

    return {
      changed: true,
      data: { ...data, cursor: null },
      reason: "cursor-suppressed",
      remoteCursor,
      stats: {
        paginationFirewall: true,
        paginationOlderPageBlocked: false,
        paginationCursorSuppressed: true,
        paginationBlockedNodes: 0
      }
    };
  }

  global.CGPaginationFirewall = Object.freeze({ apply, isCursorRequest, cursorValue });
  if (typeof module !== "undefined" && module.exports) module.exports = global.CGPaginationFirewall;
})(typeof globalThis !== "undefined" ? globalThis : this);
