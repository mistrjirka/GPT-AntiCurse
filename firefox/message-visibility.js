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

  function fileIdFromValue(value) {
    const text = String(value || "").trim();
    if (!text) return null;
    const pointer = text.match(/^(?:sediment|file-service):\/\/(file_[A-Za-z0-9_-]+)$/i);
    if (pointer) return pointer[1];
    return /^file_[A-Za-z0-9_-]+$/i.test(text) ? text : null;
  }

  function firstTextField(value, names) {
    if (!value || typeof value !== "object") return "";
    for (const name of names) {
      const candidate = value[name];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    return "";
  }

  function fileReferences(message) {
    if (!message || typeof message !== "object") return [];
    const result = [];
    const byId = new Map();
    let visited = 0;

    function add(value, contextKind = "") {
      if (value == null) return;
      const object = value && typeof value === "object" ? value : null;
      const rawId = object
        ? firstTextField(object, ["asset_pointer", "file_id", "fileId", "id", "download_id"])
        : value;
      const fileId = fileIdFromValue(rawId);
      if (!fileId) return;
      const name = object ? firstTextField(object, ["file_name", "filename", "name", "display_name", "title"]) : "";
      const mimeType = object ? firstTextField(object, ["mime_type", "mimeType"]) : "";
      const kind = object ? firstTextField(object, ["content_type", "type", "kind"]) : "";
      const sizeValue = object && (object.size_bytes ?? object.file_size_bytes ?? object.size);
      const sizeBytes = Number.isFinite(Number(sizeValue)) ? Math.max(0, Number(sizeValue)) : null;
      const existing = byId.get(fileId);
      if (existing) {
        if (!existing.name && name) existing.name = name;
        if (!existing.mimeType && mimeType) existing.mimeType = mimeType;
        if (!existing.kind && (kind || contextKind)) existing.kind = kind || contextKind;
        if (existing.sizeBytes == null && sizeBytes != null) existing.sizeBytes = sizeBytes;
        return;
      }
      const item = { fileId, name, mimeType, kind: kind || contextKind, sizeBytes };
      byId.set(fileId, item);
      result.push(item);
    }

    function scan(value, depth = 0, contextKind = "") {
      if (value == null || depth > 5 || visited > 160) return;
      if (typeof value === "string") {
        if (value.includes("file_") || value.includes("sediment://") || value.includes("file-service://")) add(value, contextKind);
        return;
      }
      if (typeof value !== "object") return;
      visited++;
      add(value, contextKind);
      if (Array.isArray(value)) {
        for (const item of value) scan(item, depth + 1, contextKind);
        return;
      }
      const nextKind = firstTextField(value, ["content_type", "type", "kind"]) || contextKind;
      for (const [key, child] of Object.entries(value)) {
        if (["dalle", "generation", "image_metadata", "model_slug", "finish_details"].includes(key)) continue;
        scan(child, depth + 1, nextKind);
      }
    }

    scan(message.content);
    const metadata = message.metadata;
    if (metadata && typeof metadata === "object") {
      const relevant = /(?:file|asset|attach|reference|sandbox|download|artifact|output|image)/i;
      for (const [key, value] of Object.entries(metadata)) {
        if (relevant.test(key)) scan(value);
        else if (typeof value === "string" && (value.includes("file_") || value.includes("sediment://") || value.includes("file-service://"))) scan(value);
      }
    }
    return result;
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
    const attachments = fileReferences(message);
    let text = contentToText(message.content).trim();
    if (attachments.length) {
      text = text.replace(/(?:^|\n)\s*\[Image \/ attachment\]\s*(?=\n|$)/gi, "\n").replace(/\n{3,}/g, "\n\n").trim();
    }
    if (!text && !attachments.length) return null;
    return {
      id: String(message.id || fallbackId || "").trim() || String(fallbackId || ""),
      role: role(message),
      text,
      attachments,
      createTime: message.create_time == null ? null : message.create_time,
      contentType: contentType(message) || null,
      channel: channel(message) || null
    };
  }

  function nearbyConversationMessage(messages, from, step) {
    const list = Array.isArray(messages) ? messages : [];
    for (let index = from + step; index >= 0 && index < list.length; index += step) {
      const message = list[index];
      const messageRole = role(message);
      if (messageRole !== "user" && messageRole !== "assistant") continue;
      if (isHidden(message) || isPrivateInternal(message)) continue;
      if (messageRole === "assistant" && isToolTargeted(message)) continue;
      return { message, index };
    }
    return null;
  }

  function isRecoveryContinuationAt(messages, index) {
    const list = Array.isArray(messages) ? messages : [];
    const current = list[index];
    if (!current || role(current) !== "user" || !isDisplayMessage(current)) return false;
    if (contentToText(current.content).trim() !== "." || fileReferences(current).length) return false;
    const previous = nearbyConversationMessage(list, index, -1);
    const next = nearbyConversationMessage(list, index, 1);
    if (!previous || !next) return false;
    if (role(previous.message) !== "assistant" || role(next.message) !== "assistant") return false;
    if (!isDisplayMessage(previous.message) || !isDisplayMessage(next.message)) return false;
    return contentToText(previous.message.content).trim() === "";
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
    fileReferences,
    historyEntry,
    isRecoveryContinuationAt
  });

  global.CGAntiCurseMessageVisibility = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
