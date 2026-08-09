/*
 * Pure conversation-graph transformation logic.
 *
 * This module has no browser API dependencies and is loaded by the unit tests.
 * It operates only on the conversation document returned by ChatGPT.
 */
(function (global) {
  "use strict";

  const VALID_MODES = new Set([
    "visible-history",
    "recent",
    "latest-visible",
    "windowed-visible"
  ]);

  const DEFAULTS = Object.freeze({
    mode: "visible-history",
    maxDisplayMessages: 32,
    maxPrefixNodes: 4
  });

  function getMessage(node) {
    return node && node.message ? node.message : null;
  }

  function getRole(node) {
    const message = getMessage(node);
    return message && message.author ? message.author.role : undefined;
  }

  function isExplicitlyHidden(node) {
    const message = getMessage(node);
    const metadata = message && message.metadata;
    return !!(metadata && (
      metadata.is_visually_hidden_from_conversation === true ||
      metadata.is_user_system_message === true
    ));
  }

  function isDisplayCandidate(node) {
    if (!node || !node.message || isExplicitlyHidden(node)) return false;
    const role = getRole(node);
    return role === "user" || role === "assistant";
  }

  function buildActiveChain(mapping, currentId) {
    const reverseChain = [];
    const visited = new Set();
    let id = currentId;

    while (id && mapping[id] && !visited.has(id)) {
      visited.add(id);
      reverseChain.push(id);
      id = mapping[id].parent || null;
    }

    reverseChain.reverse();
    return reverseChain;
  }

  function countActivePath(mapping, chain) {
    const roles = Object.create(null);
    let displayCandidates = 0;
    let explicitlyHidden = 0;
    let noMessage = 0;

    for (const id of chain) {
      const node = mapping[id];
      if (!node || !node.message) {
        noMessage++;
        roles["(none)"] = (roles["(none)"] || 0) + 1;
        continue;
      }

      const role = getRole(node) || "(unknown)";
      roles[role] = (roles[role] || 0) + 1;
      if (isExplicitlyHidden(node)) explicitlyHidden++;
      if (isDisplayCandidate(node)) displayCandidates++;
    }

    return { roles, displayCandidates, explicitlyHidden, noMessage };
  }

  function leadingPrefix(mapping, chain, maxPrefixNodes) {
    const prefix = [];
    for (const id of chain) {
      if (prefix.length >= maxPrefixNodes || isDisplayCandidate(mapping[id])) break;
      prefix.push(id);
    }
    return prefix;
  }

  function uniqueInOrder(ids) {
    const seen = new Set();
    const result = [];
    for (const id of ids) {
      if (id && !seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
    return result;
  }

  function selectVisibleHistory(mapping, chain, config) {
    const prefix = leadingPrefix(mapping, chain, config.maxPrefixNodes);
    const display = chain.filter((id) => isDisplayCandidate(mapping[id]));
    return uniqueInOrder(prefix.concat(display, chain[chain.length - 1]));
  }

  function selectLatestVisible(mapping, chain, config) {
    const display = chain.filter((id) => isDisplayCandidate(mapping[id]));
    const latest = display.slice(-config.maxDisplayMessages);
    const currentId = chain[chain.length - 1];

    // Keep a technical terminal current node if it is not itself displayable.
    if (currentId && !latest.includes(currentId)) latest.push(currentId);
    return uniqueInOrder(latest);
  }

  function findRecentCutoff(mapping, chain, displayLimit) {
    let seenDisplay = 0;

    for (let index = chain.length - 1; index >= 0; index--) {
      if (!isDisplayCandidate(mapping[chain[index]])) continue;
      seenDisplay++;
      if (seenDisplay >= displayLimit) return index;
    }

    // Fewer visible messages than the limit: keep the whole active chain.
    return 0;
  }

  function selectRecent(mapping, chain, config) {
    const cutoff = findRecentCutoff(mapping, chain, config.maxDisplayMessages);
    const prefix = leadingPrefix(mapping, chain.slice(0, cutoff), config.maxPrefixNodes);
    return uniqueInOrder(prefix.concat(chain.slice(cutoff)));
  }

  function contentToText(content) {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (typeof content.text === "string") return content.text;
    if (!Array.isArray(content.parts)) return "";

    const textParts = [];
    for (const part of content.parts) {
      if (typeof part === "string") {
        textParts.push(part);
      } else if (part && typeof part === "object") {
        if (typeof part.text === "string") textParts.push(part.text);
        else if (typeof part.content === "string") textParts.push(part.content);
        else if (part.asset_pointer || part.image_url || part.content_type === "image_asset_pointer") {
          textParts.push("[Image / attachment]");
        } else if (part.content_type) {
          textParts.push(`[${part.content_type}]`);
        }
      }
    }
    return textParts.join("\n").trim();
  }

  function extractVisibleHistory(data) {
    const mapping = data && data.mapping;
    const currentId = data && data.current_node;
    if (!mapping || typeof mapping !== "object" || !currentId || !mapping[currentId]) return [];

    const history = [];
    for (const id of buildActiveChain(mapping, currentId)) {
      const node = mapping[id];
      if (!isDisplayCandidate(node)) continue;

      const message = getMessage(node);
      history.push({
        id,
        role: getRole(node),
        text: contentToText(message && message.content),
        createTime: message && message.create_time ? message.create_time : null
      });
    }
    return history;
  }

  function rebuildLinearMapping(data, keptChain) {
    const newMapping = Object.create(null);

    for (let index = 0; index < keptChain.length; index++) {
      const id = keptChain[index];
      newMapping[id] = Object.assign({}, data.mapping[id], {
        parent: index === 0 ? null : keptChain[index - 1],
        children: index === keptChain.length - 1 ? [] : [keptChain[index + 1]]
      });
    }

    const result = Object.assign({}, data, { mapping: newMapping });
    if (Object.prototype.hasOwnProperty.call(data, "root")) {
      result.root = keptChain[0] || data.current_node;
    }
    if (!newMapping[result.current_node] && keptChain.length) {
      result.current_node = keptChain[keptChain.length - 1];
    }
    return result;
  }

  function normalizeConfig(options) {
    const config = Object.assign({}, DEFAULTS, options || {});
    if (!VALID_MODES.has(config.mode)) config.mode = DEFAULTS.mode;
    config.maxDisplayMessages = Math.max(4, Math.min(500, Number(config.maxDisplayMessages) || DEFAULTS.maxDisplayMessages));
    config.maxPrefixNodes = Math.max(0, Math.min(32, Number(config.maxPrefixNodes) || DEFAULTS.maxPrefixNodes));
    return config;
  }

  function selectKeptChain(mapping, chain, config) {
    switch (config.mode) {
      case "visible-history":
        return selectVisibleHistory(mapping, chain, config);
      case "latest-visible":
        return selectLatestVisible(mapping, chain, config);
      case "recent":
      case "windowed-visible":
        return selectRecent(mapping, chain, config);
      default:
        return selectVisibleHistory(mapping, chain, config);
    }
  }

  function canPassThroughRecent(data, chain, before, config) {
    return config.mode === "recent" &&
      before.displayCandidates <= config.maxDisplayMessages &&
      Object.keys(data.mapping).length === chain.length;
  }

  function makeStats(config, mappingNodeCount, chain, before, keptChain, after, currentPreserved) {
    return {
      trimMode: config.mode,
      mappingNodesBefore: mappingNodeCount,
      activePathNodesBefore: chain.length,
      displayBefore: before.displayCandidates,
      explicitlyHiddenBefore: before.explicitlyHidden,
      roleCountsBefore: before.roles,
      mappingNodesAfter: keptChain.length,
      displayAfter: after.displayCandidates,
      discardedNodes: mappingNodeCount - keptChain.length,
      currentNodePreserved: currentPreserved
    };
  }

  function trimConversation(data, options) {
    const mapping = data && data.mapping;
    const currentId = data && data.current_node;
    if (!mapping || typeof mapping !== "object" || !currentId || !mapping[currentId]) {
      return { changed: false, data, reason: "unsupported-shape" };
    }

    const config = normalizeConfig(options);
    const chain = buildActiveChain(mapping, currentId);
    const before = countActivePath(mapping, chain);
    const mappingNodeCount = Object.keys(mapping).length;

    if (canPassThroughRecent(data, chain, before, config)) {
      return {
        changed: false,
        data,
        reason: "below-limit",
        stats: makeStats(config, mappingNodeCount, chain, before, chain, before, true)
      };
    }

    let keptChain = selectKeptChain(mapping, chain, config);
    if (!keptChain.length) keptChain = [currentId];

    const result = rebuildLinearMapping(data, keptChain);
    const after = countActivePath(result.mapping, keptChain);

    return {
      changed: true,
      data: result,
      reason: "trimmed",
      stats: makeStats(
        config,
        mappingNodeCount,
        chain,
        before,
        keptChain,
        after,
        result.current_node === currentId
      )
    };
  }

  global.CGTrim = {
    trimConversation,
    extractVisibleHistory,
    DEFAULTS,
    isDisplayCandidate,
    isExplicitlyHidden
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.CGTrim;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
