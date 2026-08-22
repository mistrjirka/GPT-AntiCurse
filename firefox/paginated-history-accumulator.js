/* Accumulate untouched native ChatGPT pagination pages into one bounded-history archive. */
(function (global) {
  "use strict";

  const DEFAULT_MAX_PAGES = 100;

  function normalizedCursor(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  function messageKey(message, index) {
    const id = String(message && message.id || "").trim();
    if (id) return `id:${id}`;
    return `anon:${message && message.role || ""}:${message && message.createTime || ""}:${message && message.text || ""}:${index}`;
  }

  function mergeChronological(older, newer) {
    const result = [];
    const positions = new Map();
    const combined = [
      ...(Array.isArray(older) ? older : []),
      ...(Array.isArray(newer) ? newer : [])
    ];
    for (let index = 0; index < combined.length; index++) {
      const message = combined[index];
      const key = messageKey(message, index);
      if (positions.has(key)) {
        // Prefer the later/newer copy while retaining chronological position.
        result[positions.get(key)] = message;
        continue;
      }
      positions.set(key, result.length);
      result.push(message);
    }
    return result;
  }

  function historyFromState(state) {
    return {
      ok: true,
      conversationId: state.conversationId,
      messages: state.messages.slice(),
      nativeVisibleCount: Math.max(0, Number(state.nativeVisibleCount) || 0),
      pageSize: Math.max(1, Number(state.pageSize) || 64),
      maxRendered: Math.max(
        Math.max(1, Number(state.pageSize) || 64),
        Math.min(500, Math.max(1, Number(state.pageSize) || 64) * 3)
      ),
      source: "firefox-native-pagination",
      sourcePages: state.pageCount
    };
  }

  function create(options = {}) {
    const maxPages = Math.max(2, Math.min(1000, Number(options.maxPages) || DEFAULT_MAX_PAGES));
    const states = new Map();
    let completed = 0;
    let ignored = 0;
    let aborted = 0;

    function clear(tabId) {
      return states.delete(tabId);
    }

    function observe(page) {
      const tabId = Number(page && page.tabId);
      const conversationId = String(page && page.conversationId || "").trim();
      const cursorRequest = !!(page && page.cursorRequest);
      const requestCursor = normalizedCursor(page && page.requestCursor);
      const nextCursor = normalizedCursor(page && page.nextCursor);
      const messages = Array.isArray(page && page.messages) ? page.messages.slice() : [];
      if (!Number.isInteger(tabId) || tabId < 0 || !conversationId) {
        ignored++;
        return { accepted: false, complete: false, continueNativePagination: false, reason: "invalid-page" };
      }

      if (!cursorRequest) {
        states.delete(tabId);
        const state = {
          conversationId,
          messages,
          nextCursor,
          pageCount: 1,
          pageSize: Math.max(1, Number(page.pageSize) || 64),
          nativeVisibleCount: Math.max(0, Number(page.nativeVisibleCount) || 0),
          seenCursors: new Set(nextCursor ? [nextCursor] : [])
        };
        if (!nextCursor) {
          completed++;
          return {
            accepted: true,
            complete: true,
            continueNativePagination: false,
            history: historyFromState(state),
            pageCount: 1
          };
        }
        states.set(tabId, state);
        return {
          accepted: true,
          complete: false,
          continueNativePagination: false,
          nextCursor,
          pageCount: 1
        };
      }

      const state = states.get(tabId);
      if (!state || state.conversationId !== conversationId || !requestCursor || requestCursor !== state.nextCursor) {
        ignored++;
        return { accepted: false, complete: false, continueNativePagination: false, reason: "unexpected-page" };
      }

      state.messages = mergeChronological(messages, state.messages);
      state.pageCount++;

      if (!nextCursor) {
        states.delete(tabId);
        completed++;
        return {
          accepted: true,
          complete: true,
          continueNativePagination: false,
          history: historyFromState(state),
          pageCount: state.pageCount
        };
      }

      if (state.pageCount >= maxPages || state.seenCursors.has(nextCursor)) {
        states.delete(tabId);
        aborted++;
        return {
          accepted: true,
          complete: false,
          continueNativePagination: false,
          reason: state.pageCount >= maxPages ? "page-limit" : "cursor-loop",
          pageCount: state.pageCount
        };
      }

      state.nextCursor = nextCursor;
      state.seenCursors.add(nextCursor);
      return {
        accepted: true,
        complete: false,
        continueNativePagination: true,
        nextCursor,
        pageCount: state.pageCount
      };
    }

    function debug() {
      let bufferedMessages = 0;
      const active = [];
      for (const [tabId, state] of states) {
        bufferedMessages += state.messages.length;
        active.push({
          tabId,
          conversationId: state.conversationId,
          pageCount: state.pageCount,
          bufferedMessages: state.messages.length,
          nextCursor: !!state.nextCursor
        });
      }
      return { activeCount: states.size, bufferedMessages, completed, ignored, aborted, active };
    }

    return Object.freeze({ observe, clear, debug });
  }

  const api = Object.freeze({ create, mergeChronological });
  global.CGPaginatedHistoryAccumulator = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
