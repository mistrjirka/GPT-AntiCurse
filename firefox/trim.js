/* Pure transformation logic. Also loaded by tests. */
(function (global) {
  "use strict";

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
    for (let i = 0; i < chain.length && prefix.length < maxPrefixNodes; i++) {
      const node = mapping[chain[i]];
      if (isDisplayCandidate(node)) break;
      prefix.push(chain[i]);
    }
    return prefix;
  }

  function uniqueInOrder(ids) {
    const seen = new Set();
    const out = [];
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }

  function selectVisibleHistory(mapping, chain, cfg) {
    const prefix = leadingPrefix(mapping, chain, cfg.maxPrefixNodes);
    const display = chain.filter((id) => isDisplayCandidate(mapping[id]));
    return uniqueInOrder(prefix.concat(display, chain[chain.length - 1]));
  }

  function selectLatestVisible(mapping, chain, cfg) {
    const display = chain.filter((id) => isDisplayCandidate(mapping[id]));
    const latest = display.slice(-cfg.maxDisplayMessages);
    // Finished conversations normally have a visible current_node. If ChatGPT leaves a
    // technical terminal node, retain only that one extra node so continuation remains safe.
    const currentId = chain[chain.length - 1];
    if (currentId && !latest.includes(currentId)) latest.push(currentId);
    return uniqueInOrder(latest);
  }

  function selectRecent(mapping, chain, cfg) {
    let seenDisplay = 0;
    let cutoff = chain.length - 1;

    for (let i = chain.length - 1; i >= 0; i--) {
      if (isDisplayCandidate(mapping[chain[i]])) {
        seenDisplay++;
        if (seenDisplay >= cfg.maxDisplayMessages) {
          cutoff = i;
          break;
        }
      }
    }

    const prefix = leadingPrefix(mapping, chain.slice(0, cutoff), cfg.maxPrefixNodes);
    return uniqueInOrder(prefix.concat(chain.slice(cutoff)));
  }

  function contentToText(content) {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (typeof content.text === "string") return content.text;
    if (Array.isArray(content.parts)) {
      const out = [];
      for (const part of content.parts) {
        if (typeof part === "string") {
          out.push(part);
        } else if (part && typeof part === "object") {
          if (typeof part.text === "string") out.push(part.text);
          else if (typeof part.content === "string") out.push(part.content);
          else if (part.asset_pointer || part.image_url || part.content_type === "image_asset_pointer") out.push("[Image / attachment]");
          else if (part.content_type) out.push(`[${part.content_type}]`);
        }
      }
      return out.join("\n").trim();
    }
    return "";
  }

  function extractVisibleHistory(data) {
    const mapping = data && data.mapping;
    const currentId = data && data.current_node;
    if (!mapping || typeof mapping !== "object" || !currentId || !mapping[currentId]) return [];
    const chain = buildActiveChain(mapping, currentId);
    const out = [];
    for (const id of chain) {
      const node = mapping[id];
      if (!isDisplayCandidate(node)) continue;
      const message = getMessage(node);
      out.push({
        id,
        role: getRole(node),
        text: contentToText(message && message.content),
        createTime: message && message.create_time ? message.create_time : null
      });
    }
    return out;
  }

  function rebuildLinearMapping(data, keptChain) {
    const mapping = data.mapping;
    const newMapping = Object.create(null);

    for (let i = 0; i < keptChain.length; i++) {
      const id = keptChain[i];
      const original = mapping[id];
      newMapping[id] = Object.assign({}, original, {
        parent: i === 0 ? null : keptChain[i - 1],
        children: i === keptChain.length - 1 ? [] : [keptChain[i + 1]]
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

  function trimConversation(data, options) {
    const cfg = Object.assign({}, DEFAULTS, options || {});
    const mapping = data && data.mapping;
    const currentId = data && data.current_node;

    if (!mapping || typeof mapping !== "object" || !currentId || !mapping[currentId]) {
      return { changed: false, data, reason: "unsupported-shape" };
    }

    const mappingNodeCount = Object.keys(mapping).length;
    const chain = buildActiveChain(mapping, currentId);
    const before = countActivePath(mapping, chain);
    const isLimitedMode = cfg.mode === "recent" || cfg.mode === "latest-visible" || cfg.mode === "windowed-visible";

    if (isLimitedMode) {
      cfg.maxDisplayMessages = Math.max(4, Math.min(500, Number(cfg.maxDisplayMessages) || DEFAULTS.maxDisplayMessages));
    }

    let keptChain;
    if (cfg.mode === "visible-history") {
      keptChain = selectVisibleHistory(mapping, chain, cfg);
    } else if (cfg.mode === "latest-visible" || cfg.mode === "windowed-visible") {
      keptChain = selectLatestVisible(mapping, chain, cfg);
    } else {
      if (before.displayCandidates <= cfg.maxDisplayMessages && mappingNodeCount === chain.length) {
        return {
          changed: false,
          data,
          reason: "below-limit",
          stats: {
            trimMode: cfg.mode,
            mappingNodesBefore: mappingNodeCount,
            activePathNodesBefore: chain.length,
            displayBefore: before.displayCandidates,
            explicitlyHiddenBefore: before.explicitlyHidden,
            roleCountsBefore: before.roles,
            mappingNodesAfter: mappingNodeCount,
            displayAfter: before.displayCandidates
          }
        };
      }
      keptChain = selectRecent(mapping, chain, cfg);
    }

    if (!keptChain.length) keptChain = [currentId];

    const result = rebuildLinearMapping(data, keptChain);
    const after = countActivePath(result.mapping, keptChain);

    return {
      changed: true,
      data: result,
      reason: "trimmed",
      stats: {
        trimMode: cfg.mode,
        mappingNodesBefore: mappingNodeCount,
        activePathNodesBefore: chain.length,
        displayBefore: before.displayCandidates,
        explicitlyHiddenBefore: before.explicitlyHidden,
        roleCountsBefore: before.roles,
        mappingNodesAfter: keptChain.length,
        displayAfter: after.displayCandidates,
        discardedNodes: mappingNodeCount - keptChain.length,
        currentNodePreserved: result.current_node === currentId
      }
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
