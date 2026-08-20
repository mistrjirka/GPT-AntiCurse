/* Pure raw-conversation -> export snapshot extraction. Loaded only in the isolated extension world. */
(function (global) {
  "use strict";

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
        else if (part.asset_pointer || part.image_url || part.content_type === "image_asset_pointer") parts.push("[Image / attachment]");
        else if (part.content_type) parts.push(`[${part.content_type}]`);
      }
    }
    return parts.join("\n").trim();
  }

  function activeChain(data) {
    const mapping = data && data.mapping;
    let id = data && data.current_node;
    if (!mapping || typeof mapping !== "object" || !id || !mapping[id]) return [];
    const reverse = [];
    const seen = new Set();
    while (id && mapping[id] && !seen.has(id)) {
      seen.add(id);
      reverse.push(id);
      id = mapping[id].parent || null;
    }
    reverse.reverse();
    return reverse;
  }

  function isHidden(message) {
    const metadata = message && message.metadata;
    return !!(metadata && (
      metadata.is_visually_hidden_from_conversation === true ||
      metadata.is_user_system_message === true
    ));
  }

  function isExplicitToolCall(message, role) {
    if (role !== "assistant") return false;
    const recipient = String(message && message.recipient || "").trim().toLowerCase();
    return !!recipient && recipient !== "all" && recipient !== "assistant";
  }

  function isStructuredPlanPayload(message, role) {
    if (role !== "assistant") return false;
    const text = contentToText(message && message.content);
    if (!text || text[0] !== "{") return false;
    try {
      const value = JSON.parse(text);
      return !!value && !Array.isArray(value) && Array.isArray(value.plan) &&
        value.plan.some((item) => item && typeof item.step === "string" && item.step.trim());
    } catch (error) {
      void error;
      return false;
    }
  }

  function createArchive(data, options = {}) {
    const id = String(options.id || data?.id || data?.conversation_id || "").trim();
    if (!id) return null;
    const messages = [];
    for (const nodeId of activeChain(data)) {
      const node = data.mapping[nodeId];
      const message = node && node.message;
      const role = message && message.author && message.author.role;
      if (role !== "user" && role !== "assistant") continue;
      const hidden = isHidden(message);
      const explicitToolCall = isExplicitToolCall(message, role);
      const structuredPlan = isStructuredPlanPayload(message, role);
      if (role === "user" && hidden) continue;
      // Export hidden assistant state only when it is an explicitly supported
      // technical artifact (tool call or structured plan), never arbitrary narration.
      if (role === "assistant" && hidden && !explicitToolCall && !structuredPlan) continue;
      const text = contentToText(message.content);
      if (!text) continue;
      messages.push({
        id: nodeId,
        role,
        text,
        createTime: message.create_time == null ? null : message.create_time,
        recipient: typeof message.recipient === "string" ? message.recipient : "",
        hidden
      });
    }
    const title = String(options.title || data?.title || "ChatGPT conversation").replace(/\s+/g, " ").trim() || "ChatGPT conversation";
    return {
      schemaVersion: 1,
      id,
      title,
      sourceUrl: options.sourceUrl || "https://chatgpt.com/",
      updatedAt: options.updatedAt || new Date().toISOString(),
      complete: true,
      messages
    };
  }

  function normalizeRendered(message) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) return null;
    const text = String(message.text || "").replace(/\r\n/g, "\n").trim();
    if (!text) return null;
    const turnIndex = Number(message.turnIndex);
    return {
      role: message.role,
      text,
      turnIndex: Number.isInteger(turnIndex) && turnIndex >= 0 ? turnIndex : null
    };
  }

  function normalizedText(value) {
    return String(value || "").replace(/\r\n/g, "\n").trim();
  }

  function textsCompatible(left, right) {
    const a = normalizedText(left);
    const b = normalizedText(right);
    return !!a && !!b && (a === b || a.startsWith(b) || b.startsWith(a));
  }

  function strongerText(current, candidate) {
    const a = normalizedText(current);
    const b = normalizedText(candidate);
    if (!b) return current || "";
    if (!a) return candidate;
    return b.length > a.length && b.startsWith(a) ? candidate : current;
  }

  function isExportTechnical(message) {
    if (!message || message.role !== "assistant") return false;
    const recipient = String(message.recipient || "").trim().toLowerCase();
    return !!recipient && recipient !== "all" && recipient !== "assistant";
  }

  function isRenderedProjectionMessage(message) {
    return !!message &&
      (message.role === "user" || message.role === "assistant") &&
      message.hidden !== true &&
      !isExportTechnical(message);
  }

  function renderedProjection(messages) {
    const positions = [];
    for (let index = 0; index < messages.length; index++) {
      if (isRenderedProjectionMessage(messages[index])) positions.push(index);
    }
    return positions;
  }

  function mergeRenderedTail(archive, renderedMessages) {
    if (!archive || !Array.isArray(archive.messages)) return archive || null;
    const rendered = (Array.isArray(renderedMessages) ? renderedMessages : [])
      .map(normalizeRendered)
      .filter(Boolean);
    if (!rendered.length) return archive;

    const result = { ...archive, messages: archive.messages.map((message) => ({ ...message })) };
    const positions = renderedProjection(result.messages);
    if (!positions.length) return result;

    // DOM conversation-turn indices refer to user/assistant display turns, while
    // the raw export archive also contains explicit tool-call records. Infer one
    // stable offset against the visible projection, then map back to raw indices.
    const votes = new Map();
    const searchStart = Math.max(0, positions.length - 800);
    for (const incoming of rendered) {
      if (incoming.turnIndex == null) continue;
      for (let visibleIndex = positions.length - 1; visibleIndex >= searchStart; visibleIndex--) {
        const saved = result.messages[positions[visibleIndex]];
        if (saved.role !== incoming.role || !textsCompatible(saved.text, incoming.text)) continue;
        const offset = visibleIndex - incoming.turnIndex;
        votes.set(offset, (votes.get(offset) || 0) + 1);
        break;
      }
    }

    let offset = null;
    let bestVotes = 0;
    for (const [candidate, count] of votes) {
      if (count > bestVotes) {
        offset = candidate;
        bestVotes = count;
      }
    }

    if (offset != null) {
      for (const incoming of rendered) {
        if (incoming.turnIndex == null) continue;
        const visibleIndex = incoming.turnIndex + offset;
        if (visibleIndex < 0 || visibleIndex > positions.length) continue;
        if (visibleIndex === positions.length) {
          result.messages.push({
            id: `dom-${result.messages.length}`,
            role: incoming.role,
            text: incoming.text,
            createTime: null,
            recipient: "",
            hidden: false
          });
          positions.push(result.messages.length - 1);
          continue;
        }
        const rawIndex = positions[visibleIndex];
        const saved = result.messages[rawIndex];
        if (saved.role !== incoming.role || !textsCompatible(saved.text, incoming.text)) continue;
        saved.text = strongerText(saved.text, incoming.text);
      }
    } else {
      // A fresh authoritative response normally already has the latest tail. If
      // no trustworthy turn-index anchor exists, only extend the last displayed
      // message when its text is a clear prefix of the rendered version. Never
      // append an unanchored tail and risk duplicating a complete conversation.
      const incoming = rendered[rendered.length - 1];
      const saved = result.messages[positions[positions.length - 1]];
      if (saved && saved.role === incoming.role && textsCompatible(saved.text, incoming.text)) {
        saved.text = strongerText(saved.text, incoming.text);
      }
    }

    result.updatedAt = new Date().toISOString();
    return result;
  }

  global.CGExportExtract = Object.freeze({ createArchive, mergeRenderedTail, activeChain, contentToText });
  if (typeof module !== "undefined" && module.exports) module.exports = global.CGExportExtract;
})(typeof globalThis !== "undefined" ? globalThis : this);
