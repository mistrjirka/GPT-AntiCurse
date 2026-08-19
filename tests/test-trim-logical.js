"use strict";

const assert = require("assert");
const Core = require("../firefox/trim.js");
const Logical = require("../firefox/trim-logical.js");
const T = require("../firefox/trim-pipeline.js");

assert.equal(global.CGTrimCore, Core, "core trimmer must have its own named module");
assert.equal(global.CGTrimLogical, Logical, "logical policy must have its own named module");
assert.equal(global.CGTrim, T, "production trimmer must be composed once by trim-pipeline.js");
assert.equal(T.trimConversation, Logical.trimConversation);
assert.notEqual(Core.trimConversation, Logical.trimConversation, "logical policy must not mutate the core method");

function node(id, parent, role, metadata = {}) {
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

function link(mapping, parent, child) {
  mapping[child].parent = parent;
  mapping[parent].children.push(child);
}

function agentConversation(exchanges = 10, assistantFragments = 4) {
  const mapping = { root: node("root", null, null) };
  let parent = "root";

  for (let exchange = 0; exchange < exchanges; exchange++) {
    const user = `user-${exchange}`;
    mapping[user] = node(user, parent, "user");
    link(mapping, parent, user);
    parent = user;

    const tool = `tool-${exchange}`;
    mapping[tool] = node(tool, parent, "tool");
    link(mapping, parent, tool);
    parent = tool;

    const hidden = `hidden-${exchange}`;
    mapping[hidden] = node(hidden, parent, "assistant", { is_visually_hidden_from_conversation: true });
    link(mapping, parent, hidden);
    parent = hidden;

    for (let fragment = 0; fragment < assistantFragments; fragment++) {
      const assistant = `assistant-${exchange}-${fragment}`;
      mapping[assistant] = node(assistant, parent, "assistant");
      link(mapping, parent, assistant);
      parent = assistant;

      if (fragment < assistantFragments - 1) {
        const between = `tool-${exchange}-between-${fragment}`;
        mapping[between] = node(between, parent, "tool");
        link(mapping, parent, between);
        parent = between;
      }
    }
  }

  return { mapping, current_node: parent, root: "root", title: "agent" };
}

function testLogicalBudgetGroupsAssistantProgress() {
  const source = agentConversation(10, 4);
  const info = T.logicalWindowInfo(source, 6);
  assert.equal(info.totalUnits, 20, "10 users + 10 assistant presentation groups");
  assert.equal(info.rawLimit, 15, "last three exchanges contain 3 users + 12 assistant records");

  const result = T.trimConversation(source, { mode: "recent", maxDisplayMessages: 6 });
  assert.equal(result.changed, true);
  assert.equal(result.stats.logicalDisplayBefore, 20);
  assert.equal(result.stats.logicalDisplayAfter, 6);
  assert.equal(result.stats.logicalDisplayLimit, 6);
  assert.equal(result.stats.displayAfter, 15, "raw visible records may exceed logical budget");
  assert(result.data.mapping["user-7"], "first retained user-facing unit must be preserved");
  assert(!result.data.mapping["user-6"], "older exchange must be trimmed");
  assert(result.data.mapping["tool-7"], "technical state inside the retained recent slice must survive");
  assert(result.data.mapping["hidden-7"], "hidden state inside the retained recent slice must survive");
  assert(result.data.mapping["tool-9-between-2"], "interstitial tool nodes inside assistant progress must survive");
}

function testWindowedUsesSameLogicalCutoff() {
  const source = agentConversation(8, 5);
  const result = T.trimConversation(source, { mode: "windowed-visible", maxDisplayMessages: 4 });
  assert.equal(result.stats.logicalDisplayAfter, 4);
  assert.equal(result.stats.displayAfter, 12, "two exchanges contain 2 users + 10 assistant records");
  assert(result.data.mapping["user-6"]);
  assert(!result.data.mapping["user-5"]);
  assert(result.data.mapping["tool-6"]);
}


function testBelowLogicalLimitCompactsPathologicalAgentState() {
  const source = agentConversation(13, 6);
  const beforeNodes = Object.keys(source.mapping).length;
  const info = T.logicalWindowInfo(source, 64);
  assert.equal(info.totalUnits, 26, "fixture must remain below the default logical window");

  const result = T.trimConversation(source, { mode: "recent", maxDisplayMessages: 64 });
  assert.equal(result.changed, true, "tool/progress-heavy chats must not pass through solely because logical turns are below the limit");
  assert.equal(result.reason, "trimmed");
  assert.equal(result.stats.logicalDisplayBefore, 26);
  assert.equal(result.stats.logicalDisplayAfter, 26, "all user-facing logical units must survive technical compaction");
  assert.equal(result.stats.technicalCompaction, true);
  assert.equal(result.stats.technicalTailUnits, Logical.TECHNICAL_TAIL_UNITS);
  assert(result.stats.mappingNodesAfter < beforeNodes * 0.6, "pathological technical state should shrink substantially");

  assert(result.data.mapping["user-0"], "old user anchors must remain readable");
  assert(result.data.mapping["assistant-0-5"], "old final assistant anchor must remain readable");
  assert(!result.data.mapping["assistant-0-0"], "old assistant progress fragments should leave native React state");
  assert(!result.data.mapping["tool-0"], "old tool state should leave native React state");
  assert(result.data.mapping["tool-9"], "the recent technical tail must retain tool state");
  assert(result.data.mapping["assistant-9-0"], "the recent technical tail must retain progress state");
  assert.equal(result.data.current_node, source.current_node);
}


function testTechnicalTailAlsoHonorsRawNodeBudget() {
  const source = agentConversation(13, 12);
  const result = T.trimConversation(source, { mode: "recent", maxDisplayMessages: 64 });

  assert.equal(result.changed, true);
  assert.equal(result.stats.logicalDisplayAfter, 26, "node-budget compaction must preserve logical history");
  assert.equal(result.stats.technicalCompaction, true);
  assert(result.stats.technicalTailUnits < Logical.TECHNICAL_TAIL_UNITS, "tool-heavy tail should shrink below the logical-unit cap");
  assert(result.stats.technicalTailNodes <= Logical.TECHNICAL_TAIL_NODE_BUDGET, "full technical tail should honor the raw-node budget when a complete recent exchange fits");
  assert(result.data.mapping["tool-12"], "newest exchange must keep its technical state");
  assert(!result.data.mapping["tool-9"], "older technical state should compact once the raw-node budget is exhausted");
  assert(result.data.mapping["assistant-9-11"], "older exchange final assistant anchor should remain readable");
}

function testOrdinaryBelowLimitConversationStillPassesThrough() {
  const source = agentConversation(5, 1);
  const result = T.trimConversation(source, { mode: "recent", maxDisplayMessages: 64 });
  assert.equal(result.changed, false, "ordinary small chats should not be rewritten unnecessarily");
  assert.equal(result.reason, "below-limit");
  assert.equal(result.stats.technicalCompaction, false);
}

function testAdjacentUsersStayDistinct() {
  const mapping = { root: node("root", null, null) };
  let parent = "root";
  for (const id of ["user-a", "user-b", "assistant-a", "assistant-b"]) {
    const role = id.startsWith("user") ? "user" : "assistant";
    mapping[id] = node(id, parent, role);
    link(mapping, parent, id);
    parent = id;
  }
  const data = { mapping, current_node: parent, root: "root" };
  assert.equal(T.logicalWindowInfo(data, 4).totalUnits, 3, "adjacent users count separately; assistant run counts once");
}

const tests = [
  testLogicalBudgetGroupsAssistantProgress,
  testWindowedUsesSameLogicalCutoff,
  testBelowLogicalLimitCompactsPathologicalAgentState,
  testTechnicalTailAlsoHonorsRawNodeBudget,
  testOrdinaryBelowLimitConversationStillPassesThrough,
  testAdjacentUsersStayDistinct
];
for (const test of tests) test();
console.log(`logical trim tests: PASS (${tests.length})`);
