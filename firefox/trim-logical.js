/*
 * Logical visible-window budgeting policy for the graph-preserving trimmer.
 *
 * Consecutive assistant progress records count as one user-facing unit while
 * user messages remain distinct. This module does not mutate the core trimmer;
 * trim-pipeline.js composes the final production API explicitly.
 */
(function (global) {
  "use strict";

  const core = global.CGTrimCore;
  if (!core || typeof core.trimConversation !== "function") return;

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
      if (!core.isDisplayCandidate(node)) continue;
      rows.push({ id, role: getRole(node) });
    }
    return rows;
  }

  function annotateLogicalUnits(rows) {
    let unit = -1;
    let previousVisibleRole = null;
    return rows.map((row) => {
      if (row.role === "user" || row.role !== "assistant" || previousVisibleRole !== "assistant") unit++;
      previousVisibleRole = row.role;
      return { ...row, unit };
    });
  }

  function normalizeLimit(value) {
    const number = Number(value);
    return Math.max(4, Math.min(500, Number.isFinite(number) ? number : 64));
  }

  function logicalWindowInfo(data, requestedLimit) {
    const limit = normalizeLimit(requestedLimit);
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
      return core.trimConversation(data, options);
    }

    const info = logicalWindowInfo(data, options.maxDisplayMessages);
    const result = core.trimConversation(data, {
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

  const api = Object.freeze({ trimConversation, logicalWindowInfo, logicalUnitCount });
  global.CGTrimLogical = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
