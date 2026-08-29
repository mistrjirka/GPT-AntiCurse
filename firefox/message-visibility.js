/* Shared policy for deciding which ChatGPT messages are safe user-visible history. */
(function (global) {
  "use strict";

  const PRIVATE_CONTENT_TYPES = new Set([
    "thoughts",
    "reasoning_recap",
    "model_editable_context",
    "user_editable_context"
  ]);
  const PRIVATE_CHANNELS = new Set(["analysis"]);

  function normalize(value) {
    return String(value == null ? "" : value).trim().toLowerCase();
  }

  function role(message) {
    return message && message.author ? message.author.role : undefined;
  }

  function contentType(message) {
    return normalize(message && message.content && message.content.content_type);
  }

  function channel(message) {
    return normalize(message && (message.channel || message.metadata?.channel));
  }

  function isHidden(message) {
    const metadata = message && message.metadata;
    return !!(metadata && (
      metadata.is_visually_hidden_from_conversation === true ||
      metadata.is_user_system_message === true
    ));
  }

  function isToolTargeted(message) {
    if (!message || role(message) !== "assistant") return false;
    const recipient = normalize(message.recipient);
    return !!recipient && recipient !== "all" && recipient !== "assistant";
  }

  function isPrivateInternal(message) {
    if (!message) return false;
    if (PRIVATE_CONTENT_TYPES.has(contentType(message))) return true;
    return PRIVATE_CHANNELS.has(channel(message));
  }

  function isDisplayMessage(message) {
    const messageRole = role(message);
    if (messageRole !== "user" && messageRole !== "assistant") return false;
    if (isHidden(message) || isPrivateInternal(message)) return false;
    if (messageRole === "assistant" && isToolTargeted(message)) return false;
    return true;
  }

  function contentToText(content) {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (typeof content.text === "string") return content.text;
    if (!Array.isArray(content.parts)) return "";

    const parts = [];
    for (const part of content.parts) {
      if (typeof part === "string") parts.push(part);
      else if (part && typeof part === "object") {
        if (typeof part.text === "string") parts.push(part.text);
        else if (typeof part.content === "string") parts.push(part.content);
        else if (part.asset_pointer || part.image_url || part.content_type === "image_asset_pointer") {
          parts.push("[Image / attachment]");
        } else if (part.content_type) {
          parts.push(`[${part.content_type}]`);
        }
      }
    }
    return parts.join("\n").trim();
  }

  function historyEntry(message, fallbackId) {
    if (!isDisplayMessage(message)) return null;
    const text = contentToText(message.content).trim();
    if (!text) return null;
    return {
      id: String(message.id || fallbackId || "").trim() || String(fallbackId || ""),
      role: role(message),
      text,
      createTime: message.create_time == null ? null : message.create_time,
      contentType: contentType(message) || null,
      channel: channel(message) || null
    };
  }

  const api = Object.freeze({
    PRIVATE_CONTENT_TYPES,
    PRIVATE_CHANNELS,
    role,
    contentType,
    channel,
    isHidden,
    isToolTargeted,
    isPrivateInternal,
    isDisplayMessage,
    contentToText,
    historyEntry
  });

  global.CGAntiCurseMessageVisibility = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
