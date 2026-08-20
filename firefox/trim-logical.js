/*
 * Logical visible-window budgeting policy for the graph-preserving trimmer.
 *
 * Consecutive assistant progress records count as one user-facing unit while
 * user messages remain distinct. For pathological agentic chats, older units
 * inside the visible window are compacted to stable user/final-assistant
 * anchors while a small recent tail keeps its full technical state.
 */
(function (global) {
  "use strict";

  const core = global.CGTrimCore;
  if (!core || typeof core.trimConversation !== "function") return;

  const TECHNICAL_TAIL_UNITS = 8;
  const TECHNICAL_TAIL_NODE_BUDGET = 64;
  const TECHNICAL_PRESSURE_MIN_OVERHEAD = 48;
  const TECHNICAL_PRESSURE_RATIO = 2;
  const TECHNICAL_UI_SIMPLIFY_MIN_CALLS = 12;

  function getMessage(node) {
    return node && node.message ? node.message : null;
  }

  function getRole(node) {
    const message = getMessage(node);
    return message && message.author ? message.author.role : undefined;
  }

  function isToolTargetedAssistant(node) {
    if (getRole(node) !== "assistant") return false;
    const recipient = String(getMessage(node)?.recipient || "").trim().toLowerCase();
    return !!recipient && recipient !== "all" && recipient !== "assistant";
  }

  function isToolResult(node) {
    return getRole(node) === "tool";
  }

  function completionSignal(node) {
    const message = getMessage(node);
    if (!message || getRole(node) !== "assistant" || isToolTargetedAssistant(node)) return false;
    if (message.end_turn === true) return true;
    const status = String(message.status || message.metadata?.status || "").trim().toLowerCase();
    if (["finished", "finished_successfully", "complete", "completed"].includes(status)) return true;
    return !!(message.metadata && message.metadata.finish_details);
  }

  function completedTechnicalExchanges(data) {
    const chain = activeChain(data);
    const exchanges = [];
    let current = null;

    for (const id of chain) {
      const node = data.mapping[id];
      if (getRole(node) === "user") {
        if (current) exchanges.push(current);
        current = { ids: [id], technical: [], toolCalls: 0, finalAssistant: null };
        continue;
      }
      if (!current) continue;
      current.ids.push(id);
      if (isToolTargetedAssistant(node)) {
        current.technical.push(id);
        current.toolCalls++;
      } else if (isToolResult(node)) {
        current.technical.push(id);
      } else if (getRole(node) === "assistant" && !core.isExplicitlyHidden(node)) {
        current.finalAssistant = id;
      }
    }
    if (current) exchanges.push(current);

    return exchanges.filter((exchange, index) => {
      if (!exchange.technical.length || !exchange.finalAssistant) return false;
      // Any exchange followed by a later user turn is necessarily complete.
      if (index < exchanges.length - 1) return true;
      // The newest exchange is simplified only with an explicit completion
      // signal so reloading during an active tool run cannot hide live state.
      return completionSignal(data.mapping[exchange.finalAssistant]);
    });
  }

  function simplifyCompletedTechnicalUi(data) {
    const exchanges = completedTechnicalExchanges(data);
    const toolCalls = exchanges.reduce((sum, exchange) => sum + exchange.toolCalls, 0);
    if (toolCalls < TECHNICAL_UI_SIMPLIFY_MIN_CALLS) {
      return { changed: false, data, toolCalls, toolResults: 0 };
    }

    const technicalIds = new Set();
    for (const exchange of exchanges) for (const id of exchange.technical) technicalIds.add(id);
    if (!technicalIds.size) return { changed: false, data, toolCalls, toolResults: 0 };

    const mapping = Object.create(null);
    let toolCallsHidden = 0;
    let toolResultsHidden = 0;
    for (const [id, node] of Object.entries(data.mapping || {})) {
      if (!technicalIds.has(id) || !node || !node.message) {
        mapping[id] = node;
        continue;
      }
      // Leave already-hidden technical records byte-for-byte untouched. They
      // already cost no rich conversation UI, so rewriting/counting them would
      // add response churn without a performance benefit.
      if (core.isExplicitlyHidden(node)) {
        mapping[id] = node;
        continue;
      }
      const message = node.message;
      const metadata = { ...(message.metadata || {}), is_visually_hidden_from_conversation: true };
      mapping[id] = { ...node, message: { ...message, metadata } };
      if (isToolTargetedAssistant(node)) toolCallsHidden++;
      else if (isToolResult(node)) toolResultsHidden++;
    }

    return {
      changed: toolCallsHidden > 0,
      data: { ...data, mapping },
      toolCalls: toolCallsHidden,
      toolResults: toolResultsHidden
    };
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

  function leadingPrefix(data, chain, maxPrefixNodes) {
    const prefix = [];
    for (const id of chain) {
      if (prefix.length >= maxPrefixNodes || core.isDisplayCandidate(data.mapping[id])) break;
      prefix.push(id);
    }
    return prefix;
  }

  function rebuildLinearMapping(data, keptChain) {
    const mapping = Object.create(null);
    for (let index = 0; index < keptChain.length; index++) {
      const id = keptChain[index];
      mapping[id] = Object.assign({}, data.mapping[id], {
        parent: index === 0 ? null : keptChain[index - 1],
        children: index === keptChain.length - 1 ? [] : [keptChain[index + 1]]
      });
    }
    const result = Object.assign({}, data, { mapping });
    if (Object.prototype.hasOwnProperty.call(data, "root")) result.root = keptChain[0] || data.current_node;
    if (!mapping[result.current_node] && keptChain.length) result.current_node = keptChain[keptChain.length - 1];
    return result;
  }

  function technicalPressure(data) {
    const chain = activeChain(data);
    const rows = annotateLogicalUnits(visibleRows(data));
    const totalUnits = rows.length ? rows[rows.length - 1].unit + 1 : 0;
    const overheadNodes = Math.max(0, chain.length - totalUnits);
    const threshold = Math.max(TECHNICAL_PRESSURE_MIN_OVERHEAD, totalUnits * TECHNICAL_PRESSURE_RATIO);
    return {
      chain,
      rows,
      totalUnits,
      overheadNodes,
      threshold,
      pressured: totalUnits > 2 && overheadNodes >= threshold
    };
  }

  function compactTechnicalHistory(data, options = {}) {
    const pressure = technicalPressure(data);
    if (!pressure.pressured) return { changed: false, data, pressure };

    const maxTailUnits = Math.min(TECHNICAL_TAIL_UNITS, pressure.totalUnits);
    const maxTailCutoffUnit = pressure.totalUnits - maxTailUnits;
    const candidateUsers = pressure.rows.filter((row) => row.role === "user" && row.unit >= maxTailCutoffUnit);
    let tailFirst = null;

    // Keep as many complete recent exchanges as fit the raw-node budget. If the
    // newest exchange alone is larger than the budget, preserve that exchange
    // intact and compact every older one rather than slicing live tool state.
    for (const row of candidateUsers) {
      const index = pressure.chain.indexOf(row.id);
      if (index >= 0 && pressure.chain.length - index <= TECHNICAL_TAIL_NODE_BUDGET) {
        tailFirst = row;
        break;
      }
    }
    if (!tailFirst && candidateUsers.length) tailFirst = candidateUsers[candidateUsers.length - 1];
    if (!tailFirst) tailFirst = pressure.rows.find((row) => row.unit >= maxTailCutoffUnit) || null;

    const tailStartIndex = tailFirst ? pressure.chain.indexOf(tailFirst.id) : -1;
    if (tailStartIndex < 0) return { changed: false, data, pressure };
    const tailCutoffUnit = tailFirst.unit;
    const tailUnits = Math.max(0, pressure.totalUnits - tailCutoffUnit);

    const keep = new Set(leadingPrefix(data, pressure.chain, Math.max(0, Math.min(32, Number(options.maxPrefixNodes) || 4))));
    const assistantAnchorByUnit = new Map();

    for (const row of pressure.rows) {
      if (row.unit >= tailCutoffUnit) continue;
      if (row.role === "user") {
        keep.add(row.id);
        continue;
      }
      const current = assistantAnchorByUnit.get(row.unit);
      if (!current || isToolTargetedAssistant(data.mapping[current]) || !isToolTargetedAssistant(data.mapping[row.id])) {
        assistantAnchorByUnit.set(row.unit, row.id);
      }
    }
    for (const id of assistantAnchorByUnit.values()) keep.add(id);
    for (let index = tailStartIndex; index < pressure.chain.length; index++) keep.add(pressure.chain[index]);

    const keptChain = pressure.chain.filter((id) => keep.has(id));
    if (!keptChain.length || keptChain.length >= pressure.chain.length) return { changed: false, data, pressure };

    return {
      changed: true,
      data: rebuildLinearMapping(data, keptChain),
      pressure,
      tailUnits,
      tailCutoffUnit,
      tailNodeCount: pressure.chain.length - tailStartIndex,
      nodesBefore: pressure.chain.length,
      nodesAfter: keptChain.length,
      nodesDropped: pressure.chain.length - keptChain.length
    };
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

    if (!result || !result.stats) return result;

    result.stats.logicalDisplayBefore = info.totalUnits;
    result.stats.logicalDisplayAfter = logicalUnitCount(result.data);
    result.stats.logicalDisplayLimit = info.limit;
    result.stats.rawDisplayLimit = info.rawLimit;

    // Existing Recent-N semantics deliberately preserve all technical nodes
    // inside an actually truncated recent window. The extra compaction is only
    // for the pathological case where the whole logical conversation fits under
    // N but raw agent/tool/progress state is still enormous.
    const compacted = info.totalUnits <= info.limit
      ? compactTechnicalHistory(result.data, options)
      : { changed: false, data: result.data, pressure: technicalPressure(result.data) };
    result.stats.technicalOverheadBefore = compacted.pressure.overheadNodes;
    result.stats.technicalOverheadThreshold = compacted.pressure.threshold;
    result.stats.technicalCompaction = compacted.changed;

    const mappingBefore = Math.max(0, Number(result.stats.mappingNodesBefore) || Object.keys(data.mapping || {}).length);
    if (compacted.changed) {
      result.changed = true;
      result.data = compacted.data;
      result.reason = "trimmed";
      result.stats.mappingNodesAfter = Object.keys(compacted.data.mapping || {}).length;
      result.stats.discardedNodes = Math.max(0, mappingBefore - result.stats.mappingNodesAfter);
      result.stats.displayAfter = visibleRows(compacted.data).length;
      result.stats.logicalDisplayAfter = logicalUnitCount(compacted.data);
      result.stats.currentNodePreserved = !!(compacted.data.current_node && compacted.data.current_node === data.current_node);
      result.stats.technicalTailUnits = compacted.tailUnits;
      result.stats.technicalTailNodes = compacted.tailNodeCount;
      result.stats.technicalTailNodeBudget = TECHNICAL_TAIL_NODE_BUDGET;
      result.stats.technicalNodesDropped = compacted.nodesDropped;
    }

    const simplified = simplifyCompletedTechnicalUi(result.data);
    result.stats.technicalUiSimplified = simplified.changed;
    result.stats.technicalUiToolCallsHidden = simplified.toolCalls;
    result.stats.technicalUiToolResultsHidden = simplified.toolResults;
    result.stats.technicalUiSimplifyMinCalls = TECHNICAL_UI_SIMPLIFY_MIN_CALLS;
    if (simplified.changed) {
      result.changed = true;
      result.data = simplified.data;
      result.reason = "trimmed";
      // Nodes are deliberately retained; only their visual eligibility changes.
      result.stats.mappingNodesAfter = Object.keys(simplified.data.mapping || {}).length;
      result.stats.discardedNodes = Math.max(0, mappingBefore - result.stats.mappingNodesAfter);
      result.stats.displayAfter = visibleRows(simplified.data).length;
      result.stats.logicalDisplayAfter = logicalUnitCount(simplified.data);
    }
    return result;
  }

  const api = Object.freeze({
    trimConversation,
    logicalWindowInfo,
    logicalUnitCount,
    technicalPressure,
    compactTechnicalHistory,
    completedTechnicalExchanges,
    simplifyCompletedTechnicalUi,
    TECHNICAL_TAIL_UNITS,
    TECHNICAL_TAIL_NODE_BUDGET,
    TECHNICAL_UI_SIMPLIFY_MIN_CALLS
  });
  global.CGTrimLogical = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
