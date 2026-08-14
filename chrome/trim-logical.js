/*
 * Logical visible-window budgeting layered over the graph-preserving trimmer.
 *
 * A long agent response can contain many consecutive visible assistant records.
 * Those records count as one user-facing assistant unit for the Recent-N budget,
 * while every user message remains its own unit. The underlying trimmer still
 * keeps every technical/tool/hidden node between the chosen cutoff and current
 * node, so this changes the budget only, not recent graph semantics.
 */
(function (global) {
  "use strict";

  const trim = global.CGTrim;
  if (!trim || typeof trim.trimConversation !== "function") return;

  const baseTrimConversation = trim.trimConversation;

  function getRole(node) {
    return node && node.message && node.message.author ? node.message.author.role : undefined;
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

  function visibleRows(data) {
    const mapping = data && data.mapping;
    const rows = [];
    for (const id of activeChain(data)) {
      const node = mapping[id];
      if (!trim.isDisplayCandidate(node)) continue;
      rows.push({ id, role: getRole(node) });
    }
    return rows;
  }

  function annotateLogicalUnits(rows) {
    let unit = -1;
    let previousVisibleRole = null;
    return rows.map((row) => {
      // Consecutive assistant records are one presentation unit. User messages
      // remain distinct even if two user messages are adjacent.
      if (row.role === "user" || row.role !== "assistant" || previousVisibleRole !== "assistant") unit++;
      previousVisibleRole = row.role;
      return { ...row, unit };
    });
  }

  function logicalWindowInfo(data, requestedLimit) {
    const limit = Math.max(4, Math.min(500, Number(requestedLimit) || 64));
    const rows = annotateLogicalUnits(visibleRows(data));
    const totalUnits = rows.length ? rows[rows.length - 1].unit + 1 : 0;

    if (!rows.length || totalUnits <= limit) {
      return { limit, totalUnits, rawLimit: rows.length, cutoffUnit: 0 };
    }

    const cutoffUnit = totalUnits - limit;
    const firstKept = rows.findIndex((row) => row.unit >= cutoffUnit);
    return {
      limit,
      totalUnits,
      rawLimit: firstKept < 0 ? rows.length : rows.length - firstKept,
      cutoffUnit
    };
  }

  function logicalUnitCount(data) {
    const rows = annotateLogicalUnits(visibleRows(data));
    return rows.length ? rows[rows.length - 1].unit + 1 : 0;
  }

  function trimConversation(data, options = {}) {
    const mode = options && options.mode;
    if (mode !== "recent" && mode !== "windowed-visible") {
      return baseTrimConversation(data, options);
    }

    const info = logicalWindowInfo(data, options.maxDisplayMessages);
    const result = baseTrimConversation(data, {
      ...options,
      maxDisplayMessages: Math.max(4, info.rawLimit || info.limit)
    });

    if (result && result.stats) {
      result.stats.logicalDisplayBefore = info.totalUnits;
      result.stats.logicalDisplayAfter = logicalUnitCount(result.data);
      result.stats.logicalDisplayLimit = info.limit;
      result.stats.rawDisplayLimit = info.rawLimit;
    }
    return result;
  }

  trim.trimConversation = trimConversation;
  trim.logicalWindowInfo = logicalWindowInfo;
  trim.logicalUnitCount = logicalUnitCount;

  if (typeof module !== "undefined" && module.exports) module.exports = trim;
})(typeof globalThis !== "undefined" ? globalThis : this);
