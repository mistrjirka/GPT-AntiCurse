/* Shared exact ChatGPT conversation-document endpoint parser. */
(function (global) {
  "use strict";

  const CHATGPT_ORIGIN = "https://chatgpt.com";
  const DOCUMENT_PATH = /^\/backend-api\/(conversation|conversations)\/([^/]+)\/?$/;
  const RESERVED_SEGMENTS = new Set(["init", "search"]);

  function parse(urlString, baseUrl = `${CHATGPT_ORIGIN}/`) {
    try {
      const url = new URL(urlString, baseUrl);
      if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") return null;
      const match = url.pathname.match(DOCUMENT_PATH);
      if (!match) return null;
      const id = decodeURIComponent(match[2]).trim();
      if (!id || RESERVED_SEGMENTS.has(id.toLowerCase())) return null;
      return {
        id,
        family: match[1],
        url: url.href
      };
    } catch (_) {
      return null;
    }
  }

  function conversationId(urlString, baseUrl) {
    return parse(urlString, baseUrl)?.id || null;
  }

  function isConversationDocument(urlString, baseUrl) {
    return !!parse(urlString, baseUrl);
  }

  global.CGConversationEndpoint = Object.freeze({ parse, conversationId, isConversationDocument });
  if (typeof module !== "undefined" && module.exports) module.exports = global.CGConversationEndpoint;
})(typeof globalThis !== "undefined" ? globalThis : this);
