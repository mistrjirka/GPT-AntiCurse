"use strict";

const assert = require("assert");
const {
  trimConversation,
  extractVisibleHistory,
  isDisplayCandidate
} = require("../firefox/trim.js");

function makeNode(id, parent, role, metadata = {}) {
  return {
    id,
    parent,
    children: [],
    message: role
      ? {
          author: { role },
          content: { content_type: "text", parts: [id] },
          metadata
        }
      : null
  };
}

function link(mapping, parent, child) {
  mapping[child].parent = parent;
  mapping[parent].children.push(child);
}

function buildToolHeavyConversation(turns = 40, toolsPerTurn = 5) {
  const mapping = { root0: makeNode("root0", null, null) };
  let parent = "root0";

  for (let turn = 0; turn < turns; turn++) {
    const userId = `user-${turn}`;
    mapping[userId] = makeNode(userId, parent, "user");
    link(mapping, parent, userId);
    parent = userId;

    for (let tool = 0; tool < toolsPerTurn; tool++) {
      const toolId = `tool-${turn}-${tool}`;
      mapping[toolId] = makeNode(toolId, parent, "tool");
      link(mapping, parent, toolId);
      parent = toolId;
    }

    const hiddenId = `assistant-hidden-${turn}`;
    mapping[hiddenId] = makeNode(hiddenId, parent, "assistant", {
      is_visually_hidden_from_conversation: true
    });
    link(mapping, parent, hiddenId);
    parent = hiddenId;

    const assistantId = `assistant-${turn}`;
    mapping[assistantId] = makeNode(assistantId, parent, "assistant");
    link(mapping, parent, assistantId);
    parent = assistantId;
  }

  if (turns > 11) {
    mapping["branch-old"] = makeNode("branch-old", "assistant-10", "assistant");
    mapping["assistant-10"].children.push("branch-old");
  } else {
    mapping["branch-old"] = makeNode("branch-old", parent, "assistant");
    mapping[parent].children.push("branch-old");
  }

  return {
    mapping,
    current_node: parent,
    root: "root0",
    title: "mock"
  };
}

function assertLinearMapping(data) {
  let id = data.root;
  let previous = null;
  const seen = new Set();

  while (id) {
    assert(!seen.has(id), `cycle detected at ${id}`);
    seen.add(id);

    const node = data.mapping[id];
    assert(node, `missing node ${id}`);
    assert.equal(node.parent, previous);
    assert(node.children.length <= 1);

    previous = id;
    id = node.children[0] || null;
  }

  assert.equal(previous, data.current_node);
  assert.equal(seen.size, Object.keys(data.mapping).length);
}

function testVisibleHistoryMode() {
  const source = buildToolHeavyConversation();
  const result = trimConversation(source, { mode: "visible-history" });

  assert.equal(result.changed, true);
  assert.equal(result.stats.displayBefore, 80);
  assert.equal(result.stats.displayAfter, 80);
  assert.equal(result.stats.roleCountsBefore.tool, 200);
  assert.equal(result.stats.explicitlyHiddenBefore, 40);
  assert(result.stats.mappingNodesAfter <= 82);
  assert(!result.data.mapping["tool-39-0"]);
  assert(!result.data.mapping["assistant-hidden-39"]);
  assert(!result.data.mapping["branch-old"]);
  assertLinearMapping(result.data);
}

function testRecentSafeWindow() {
  const source = buildToolHeavyConversation();
  const result = trimConversation(source, {
    mode: "recent",
    maxDisplayMessages: 24
  });

  assert.equal(result.changed, true);
  assert.equal(result.stats.displayAfter, 24);
  assert(result.stats.mappingNodesAfter > 24);
  assert(result.data.mapping["tool-39-0"]);
  assert(!result.data.mapping["user-0"]);
  assertLinearMapping(result.data);
}

function testRecentModeBelowLimitKeepsWholeActiveChain() {
  const source = buildToolHeavyConversation(3, 2);
  const result = trimConversation(source, {
    mode: "recent",
    maxDisplayMessages: 20
  });

  assert.equal(result.changed, true, "off-branch state still needs pruning");
  assert.equal(result.stats.displayAfter, 6);
  assert(result.data.mapping["user-0"]);
  assert(result.data.mapping["tool-0-0"]);
  assert(result.data.mapping["assistant-2"]);
  assert(!result.data.mapping["branch-old"]);
  assertLinearMapping(result.data);
}

function testLatestVisibleOnly() {
  const source = buildToolHeavyConversation();
  const result = trimConversation(source, {
    mode: "latest-visible",
    maxDisplayMessages: 24
  });

  assert.equal(result.changed, true);
  assert.equal(result.stats.displayBefore, 80);
  assert.equal(result.stats.displayAfter, 24);
  assert.equal(result.stats.mappingNodesAfter, 24);
  assert(result.data.mapping["user-28"]);
  assert(result.data.mapping["assistant-39"]);
  assert(!result.data.mapping["user-27"]);
  assert(!result.data.mapping["tool-39-0"]);
  assert(!result.data.mapping["assistant-hidden-39"]);
  assertLinearMapping(result.data);
}

function testWindowedModeKeepsRecentInternalState() {
  const source = buildToolHeavyConversation();
  const result = trimConversation(source, {
    mode: "windowed-visible",
    maxDisplayMessages: 16
  });

  assert.equal(result.changed, true);
  assert.equal(result.stats.displayAfter, 16);
  assert(result.stats.mappingNodesAfter > 16, "windowed mode must retain recent interstitial state");
  assert(result.data.mapping["tool-39-0"], "windowed mode must keep recent tool state");
  assert(result.data.mapping["assistant-hidden-39"], "windowed mode must keep recent hidden state");
  assert(!result.data.mapping["user-0"], "old native visible history should be removed");
  assertLinearMapping(result.data);
}

function testVisibleHistoryArchive() {
  const source = buildToolHeavyConversation();
  const history = extractVisibleHistory(source);

  assert.equal(history.length, 80);
  assert.equal(history[0].id, "user-0");
  assert.equal(history[0].role, "user");
  assert.equal(history[0].text, "user-0");
  assert.equal(history[history.length - 1].id, "assistant-39");
  assert(!history.some((message) => message.id.startsWith("tool-")));
  assert(!history.some((message) => message.id.startsWith("assistant-hidden-")));
}

function testDisplayCandidateRules() {
  assert.equal(isDisplayCandidate(makeNode("a", null, "assistant")), true);
  assert.equal(
    isDisplayCandidate(makeNode("b", null, "assistant", { is_visually_hidden_from_conversation: true })),
    false
  );
  assert.equal(
    isDisplayCandidate(makeNode("c", null, "user", { is_user_system_message: true })),
    false
  );
  assert.equal(isDisplayCandidate(makeNode("d", null, "tool")), false);
}

const tests = [
  testVisibleHistoryMode,
  testRecentSafeWindow,
  testRecentModeBelowLimitKeepsWholeActiveChain,
  testLatestVisibleOnly,
  testWindowedModeKeepsRecentInternalState,
  testVisibleHistoryArchive,
  testDisplayCandidateRules
];

for (const test of tests) test();
console.log(`trim tests: PASS (${tests.length})`);
