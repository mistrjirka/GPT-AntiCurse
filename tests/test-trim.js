"use strict";

const assert = require("assert");
const { trimConversation, extractVisibleHistory, isDisplayCandidate } = require("../firefox/trim.js");

function makeNode(id, parent, role, metadata = {}) {
  return {
    id,
    parent,
    children: [],
    message: role ? {
      author: { role },
      content: { content_type: "text", parts: [id] },
      metadata
    } : null
  };
}
function link(mapping, parent, child) { mapping[child].parent = parent; mapping[parent].children.push(child); }
function buildToolHeavyConversation(turns = 40, toolsPerTurn = 5) {
  const mapping = { root0: makeNode("root0", null, null) };
  let parent = "root0";
  for (let turn = 0; turn < turns; turn++) {
    const userId = `user-${turn}`;
    mapping[userId] = makeNode(userId, parent, "user"); link(mapping, parent, userId); parent = userId;
    for (let tool = 0; tool < toolsPerTurn; tool++) {
      const toolId = `tool-${turn}-${tool}`;
      mapping[toolId] = makeNode(toolId, parent, "tool"); link(mapping, parent, toolId); parent = toolId;
    }
    const hiddenId = `assistant-hidden-${turn}`;
    mapping[hiddenId] = makeNode(hiddenId, parent, "assistant", { is_visually_hidden_from_conversation: true });
    link(mapping, parent, hiddenId); parent = hiddenId;
    const assistantId = `assistant-${turn}`;
    mapping[assistantId] = makeNode(assistantId, parent, "assistant"); link(mapping, parent, assistantId); parent = assistantId;
  }
  const branchParent = turns > 11 ? "assistant-10" : parent;
  mapping["branch-old"] = makeNode("branch-old", branchParent, "assistant");
  mapping[branchParent].children.push("branch-old");
  return { mapping, current_node: parent, root: "root0", title: "mock" };
}
function assertLinearMapping(data) {
  let id = data.root, previous = null;
  const seen = new Set();
  while (id) {
    assert(!seen.has(id), `cycle detected at ${id}`); seen.add(id);
    const node = data.mapping[id]; assert(node, `missing node ${id}`); assert.equal(node.parent, previous); assert(node.children.length <= 1);
    previous = id; id = node.children[0] || null;
  }
  assert.equal(previous, data.current_node); assert.equal(seen.size, Object.keys(data.mapping).length);
}
function testRecentSafeWindow() {
  const result = trimConversation(buildToolHeavyConversation(), { mode: "recent", maxDisplayMessages: 24 });
  assert.equal(result.changed, true); assert.equal(result.stats.displayBefore, 80); assert.equal(result.stats.displayAfter, 24);
  assert(result.stats.mappingNodesAfter > 24); assert(result.data.mapping["tool-39-0"]); assert(result.data.mapping["assistant-hidden-39"]);
  assert(!result.data.mapping["user-0"]); assert(!result.data.mapping["branch-old"]); assertLinearMapping(result.data);
}
function testAutoUsesSameBoundedGraphSemantics() {
  const recent = trimConversation(buildToolHeavyConversation(), { mode: "recent", maxDisplayMessages: 16 });
  const auto = trimConversation(buildToolHeavyConversation(), { mode: "windowed-visible", maxDisplayMessages: 16 });
  assert.equal(auto.stats.displayAfter, 16); assert.deepEqual(Object.keys(auto.data.mapping), Object.keys(recent.data.mapping));
  assert(auto.data.mapping["tool-39-0"]); assert(auto.data.mapping["assistant-hidden-39"]); assertLinearMapping(auto.data);
}
function testBelowLimitKeepsWholeActiveChainButPrunesBranches() {
  const result = trimConversation(buildToolHeavyConversation(3, 2), { mode: "recent", maxDisplayMessages: 20 });
  assert.equal(result.changed, true); assert.equal(result.stats.displayAfter, 6); assert(result.data.mapping["user-0"]);
  assert(result.data.mapping["tool-0-0"]); assert(result.data.mapping["assistant-2"]); assert(!result.data.mapping["branch-old"]); assertLinearMapping(result.data);
}
function testUnknownLegacyModeFallsBackToRecent() {
  const result = trimConversation(buildToolHeavyConversation(), { mode: "visible-history", maxDisplayMessages: 64 });
  assert.equal(result.stats.trimMode, "recent"); assert.equal(result.stats.displayAfter, 64); assert(!result.data.mapping["user-0"]);
}
function testZeroPrefixNodesIsPreserved() {
  const result = trimConversation(buildToolHeavyConversation(), {
    mode: "recent",
    maxDisplayMessages: 4,
    maxPrefixNodes: 0
  });
  assert.equal(result.changed, true);
  assert(!result.data.mapping.root0, "explicit maxPrefixNodes=0 must not fall back to the default prefix");
  assert.notEqual(result.data.root, "root0");
  assertLinearMapping(result.data);
}
function testVisibleArchiveExtraction() {
  const history = extractVisibleHistory(buildToolHeavyConversation());
  assert.equal(history.length, 80); assert.equal(history[0].id, "user-0"); assert.equal(history.at(-1).id, "assistant-39");
  assert(!history.some((message) => message.id.startsWith("tool-"))); assert(!history.some((message) => message.id.startsWith("assistant-hidden-")));
}
function testDisplayCandidateRules() {
  assert.equal(isDisplayCandidate(makeNode("a", null, "assistant")), true);
  assert.equal(isDisplayCandidate(makeNode("b", null, "assistant", { is_visually_hidden_from_conversation: true })), false);
  assert.equal(isDisplayCandidate(makeNode("c", null, "user", { is_user_system_message: true })), false);
  assert.equal(isDisplayCandidate(makeNode("d", null, "tool")), false);
}
const tests = [testRecentSafeWindow, testAutoUsesSameBoundedGraphSemantics, testBelowLimitKeepsWholeActiveChainButPrunesBranches, testUnknownLegacyModeFallsBackToRecent, testZeroPrefixNodesIsPreserved, testVisibleArchiveExtraction, testDisplayCandidateRules];
for (const test of tests) test();
console.log(`trim tests: PASS (${tests.length})`);
