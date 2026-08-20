/*
 * Pure helpers for transient conversation history and on-demand export.
 * This file normalizes, merges, summarizes, and names visible conversation history.
 */
(function (global) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const CHATGPT_ORIGIN = "https://chatgpt.com";

  function nowIso() {
    return new Date().toISOString();
  }

  function oneLine(value, fallback = "") {
    const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    return text || fallback;
  }

  function conversationIdFromUrl(urlString) {
    if (!urlString) return null;
    try {
      const url = new URL(urlString, CHATGPT_ORIGIN);
      const backend = url.pathname.match(/^\/backend-api\/conversation\/([^/]+)\/?$/);
      if (backend) return decodeURIComponent(backend[1]);
      const page = url.pathname.match(/(?:^|\/)c\/([^/?#]+)/);
      return page ? decodeURIComponent(page[1]) : null;
    } catch (_) {
      return null;
    }
  }

  function pageUrlForConversation(id) {
    return id ? `${CHATGPT_ORIGIN}/c/${encodeURIComponent(id)}` : CHATGPT_ORIGIN;
  }

  function normalizeMessage(message, fallbackId) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) return null;
    return {
      id: oneLine(message.id, fallbackId),
      role: message.role,
      text: typeof message.text === "string" ? message.text : String(message.text || ""),
      createTime: message.createTime == null ? null : message.createTime
    };
  }

  function createArchive(data, options = {}) {
    const extractor = global.CGTrim && global.CGTrim.extractVisibleHistory;
    if (typeof extractor !== "function") return null;

    const id = oneLine(
      options.id || data?.id || data?.conversation_id ||
      conversationIdFromUrl(options.endpointUrl) || conversationIdFromUrl(options.sourceUrl)
    );
    if (!id) return null;

    const messages = extractor(data)
      .map((message, index) => normalizeMessage(message, `message-${index}`))
      .filter(Boolean);

    return {
      schemaVersion: SCHEMA_VERSION,
      id,
      title: oneLine(options.title || data?.title, "ChatGPT conversation"),
      sourceUrl: options.sourceUrl || pageUrlForConversation(id),
      updatedAt: options.updatedAt || nowIso(),
      complete: options.complete !== false,
      messages
    };
  }

  function normalizeRenderedMessage(message, index) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) return null;
    const turnIndex = Number(message.turnIndex);
    return {
      id: oneLine(message.id, `dom-${index}`),
      role: message.role,
      text: typeof message.text === "string" ? message.text : String(message.text || ""),
      createTime: message.createTime == null ? null : message.createTime,
      turnIndex: Number.isInteger(turnIndex) && turnIndex >= 0 ? turnIndex : null
    };
  }

  function comparableText(value) {
    return String(value || "").replace(/\r\n/g, "\n").trim();
  }

  function textsCompatible(left, right) {
    const a = comparableText(left);
    const b = comparableText(right);
    return !!a && !!b && (a === b || a.startsWith(b) || b.startsWith(a));
  }

  function strongerText(current, candidate) {
    const a = comparableText(current);
    const b = comparableText(candidate);
    if (!b) return current || "";
    if (!a) return candidate;
    return b.length > a.length && b.startsWith(a) ? candidate : current;
  }

  function findTurnOffset(baseMessages, rendered) {
    const votes = new Map();
    const start = Math.max(0, baseMessages.length - 800);

    for (const incoming of rendered) {
      if (incoming.turnIndex == null || !comparableText(incoming.text)) continue;
      for (let index = baseMessages.length - 1; index >= start; index--) {
        const saved = baseMessages[index];
        if (saved.role !== incoming.role || !textsCompatible(saved.text, incoming.text)) continue;
        const offset = index - incoming.turnIndex;
        votes.set(offset, (votes.get(offset) || 0) + 1);
        break;
      }
    }

    let bestOffset = null;
    let bestVotes = 0;
    for (const [offset, count] of votes) {
      if (count > bestVotes) {
        bestVotes = count;
        bestOffset = offset;
      }
    }
    return bestVotes ? bestOffset : null;
  }

  function findSuffixOverlap(baseMessages, rendered) {
    const max = Math.min(baseMessages.length, rendered.length);
    for (let count = max; count >= 1; count--) {
      let matches = true;
      for (let index = 0; index < count; index++) {
        const saved = baseMessages[baseMessages.length - count + index];
        const incoming = rendered[index];
        if (saved.role !== incoming.role || !textsCompatible(saved.text, incoming.text)) {
          matches = false;
          break;
        }
      }
      if (matches) return count;
    }
    return 0;
  }

  function appendRendered(messages, incoming, syntheticIndex) {
    messages.push({
      id: incoming.id || `dom-${syntheticIndex}`,
      role: incoming.role,
      text: incoming.text,
      createTime: incoming.createTime
    });
  }

  function mergeArchiveWithRendered(archive, renderedMessages, options = {}) {
    const rendered = (Array.isArray(renderedMessages) ? renderedMessages : [])
      .map(normalizeRenderedMessage)
      .filter((message) => message && comparableText(message.text));

    const base = archive && typeof archive === "object"
      ? { ...archive, messages: Array.isArray(archive.messages) ? archive.messages.map((message) => ({ ...message })) : [] }
      : {
          schemaVersion: SCHEMA_VERSION,
          id: oneLine(options.id),
          title: oneLine(options.title, "ChatGPT conversation"),
          sourceUrl: options.sourceUrl || pageUrlForConversation(options.id),
          updatedAt: options.updatedAt || nowIso(),
          complete: false,
          messages: []
        };

    if (!base.id) return null;
    if (!rendered.length) return { ...base, updatedAt: options.updatedAt || nowIso() };

    if (!base.messages.length) {
      rendered.forEach((message, index) => appendRendered(base.messages, message, index));
      base.complete = false;
    } else {
      const offset = findTurnOffset(base.messages, rendered);
      let positional = false;

      if (offset != null) {
        for (const incoming of rendered) {
          if (incoming.turnIndex == null) continue;
          const target = incoming.turnIndex + offset;
          if (target < 0 || target > base.messages.length) continue;
          if (target < base.messages.length) {
            const saved = base.messages[target];
            if (saved.role !== incoming.role || !textsCompatible(saved.text, incoming.text)) continue;
            saved.text = strongerText(saved.text, incoming.text);
            positional = true;
          } else {
            appendRendered(base.messages, incoming, base.messages.length);
            positional = true;
          }
        }
      }

      const overlap = findSuffixOverlap(base.messages, rendered);
      if (overlap > 0) {
        for (let index = 0; index < overlap; index++) {
          const savedIndex = base.messages.length - overlap + index;
          base.messages[savedIndex].text = strongerText(base.messages[savedIndex].text, rendered[index].text);
        }
        for (let index = overlap; index < rendered.length; index++) {
          appendRendered(base.messages, rendered[index], base.messages.length);
        }
      } else if (!positional) {
        // No trustworthy anchor: do not risk duplicating an authoritative archive.
      }
    }

    if (options.title && (base.complete === false || !base.title)) {
      base.title = oneLine(options.title, base.title);
    }
    if (options.sourceUrl) base.sourceUrl = options.sourceUrl;
    base.updatedAt = options.updatedAt || nowIso();
    return base;
  }

  function mergeNetworkArchive(existing, networkArchive) {
    if (!networkArchive) return existing || null;
    if (!existing || !Array.isArray(existing.messages) || existing.messages.length <= networkArchive.messages.length) {
      return networkArchive;
    }
    return mergeArchiveWithRendered(networkArchive, existing.messages, {
      title: networkArchive.title,
      sourceUrl: networkArchive.sourceUrl,
      updatedAt: networkArchive.updatedAt
    });
  }

  function archiveSummary(archive) {
    if (!archive) return null;
    const messages = Array.isArray(archive.messages) ? archive.messages : [];
    return {
      id: archive.id,
      title: archive.title || "ChatGPT conversation",
      sourceUrl: archive.sourceUrl || pageUrlForConversation(archive.id),
      updatedAt: archive.updatedAt || null,
      complete: archive.complete !== false,
      messageCount: messages.length,
      characters: messages.reduce((sum, message) => sum + String(message.text || "").length, 0)
    };
  }

  function archiveFilename(archive) {
    const title = oneLine(archive?.title, "chatgpt-conversation")
      .normalize("NFKD")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90) || "chatgpt-conversation";
    return `${title}.md`;
  }

  const api = Object.freeze({
    SCHEMA_VERSION,
    conversationIdFromUrl,
    pageUrlForConversation,
    createArchive,
    mergeArchiveWithRendered,
    mergeNetworkArchive,
    archiveSummary,
    archiveFilename
  });

  global.CGArchive = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
