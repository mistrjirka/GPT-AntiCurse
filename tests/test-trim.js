"use strict";
const assert = require("assert");
const { trimConversation, extractVisibleHistory, isDisplayCandidate } = require("../firefox/trim.js");

function node(id, parent, role, metadata = {}) {
  return { id, parent, children: [], message: role ? { author: { role }, content: { content_type: "text", parts: [id] }, metadata } : null };
}
function link(mapping, parent, child) { mapping[child].parent = parent; mapping[parent].children.push(child); }
function buildToolHeavy(turns = 40, toolsPerTurn = 5) {
  const mapping = { root0: node("root0", null, null) };
  let parent = "root0";
  for (let i = 0; i < turns; i++) {
    const user = `user-${i}`; mapping[user] = node(user, parent, "user"); link(mapping, parent, user); parent = user;
    for (let j = 0; j < toolsPerTurn; j++) { const tool = `tool-${i}-${j}`; mapping[tool] = node(tool, parent, "tool"); link(mapping, parent, tool); parent = tool; }
    const hidden = `assistant-hidden-${i}`; mapping[hidden] = node(hidden, parent, "assistant", { is_visually_hidden_from_conversation: true }); link(mapping, parent, hidden); parent = hidden;
    const assistant = `assistant-${i}`; mapping[assistant] = node(assistant, parent, "assistant"); link(mapping, parent, assistant); parent = assistant;
  }
  mapping["branch-old"] = node("branch-old", "assistant-10", "assistant");
  mapping["assistant-10"].children.push("branch-old");
  return { mapping, current_node: parent, root: "root0", title: "mock" };
}
function assertLinear(data) {
  let id = data.root, prev = null; const seen = new Set();
  while (id) { assert(!seen.has(id)); seen.add(id); const n = data.mapping[id]; assert(n); assert.equal(n.parent, prev); assert(n.children.length <= 1); prev = id; id = n.children[0] || null; }
  assert.equal(prev, data.current_node); assert.equal(seen.size, Object.keys(data.mapping).length);
}
{
  const src = buildToolHeavy(40, 5); const out = trimConversation(src, { mode: "visible-history" });
  assert.equal(out.changed, true); assert.equal(out.stats.displayBefore, 80); assert.equal(out.stats.displayAfter, 80); assert.equal(out.stats.roleCountsBefore.tool, 200); assert.equal(out.stats.explicitlyHiddenBefore, 40); assert(out.stats.mappingNodesAfter <= 82); assert(!out.data.mapping["tool-39-0"]); assert(!out.data.mapping["assistant-hidden-39"]); assert(!out.data.mapping["branch-old"]); assertLinear(out.data);
}
{
  const src = buildToolHeavy(40, 5); const out = trimConversation(src, { mode: "recent", maxDisplayMessages: 24 });
  assert.equal(out.changed, true); assert.equal(out.stats.displayAfter, 24); assert(out.stats.mappingNodesAfter > 24); assert(out.data.mapping["tool-39-0"]); assert(!out.data.mapping["user-0"]); assertLinear(out.data);
}
{
  const src = buildToolHeavy(40, 5); const out = trimConversation(src, { mode: "latest-visible", maxDisplayMessages: 24 });
  assert.equal(out.changed, true); assert.equal(out.stats.displayBefore, 80); assert.equal(out.stats.displayAfter, 24); assert.equal(out.stats.mappingNodesAfter, 24); assert(out.data.mapping["user-28"]); assert(out.data.mapping["assistant-39"]); assert(!out.data.mapping["user-27"]); assert(!out.data.mapping["tool-39-0"]); assert(!out.data.mapping["assistant-hidden-39"]); assertLinear(out.data);
}
{
  const src = buildToolHeavy(40, 5); const out = trimConversation(src, { mode: "windowed-visible", maxDisplayMessages: 16 });
  assert.equal(out.changed, true); assert.equal(out.stats.displayAfter, 16); assert.equal(out.stats.mappingNodesAfter, 16); assert(!out.data.mapping["tool-39-0"]); assertLinear(out.data);
}
{
  const src = buildToolHeavy(40, 5); const history = extractVisibleHistory(src);
  assert.equal(history.length, 80); assert.equal(history[0].id, "user-0"); assert.equal(history[0].role, "user"); assert.equal(history[0].text, "user-0"); assert.equal(history[history.length - 1].id, "assistant-39"); assert(!history.some((x) => x.id.startsWith("tool-"))); assert(!history.some((x) => x.id.startsWith("assistant-hidden-")));
}
{
  assert.equal(isDisplayCandidate(node("x", null, "assistant")), true);
  assert.equal(isDisplayCandidate(node("x", null, "assistant", { is_visually_hidden_from_conversation: true })), false);
  assert.equal(isDisplayCandidate(node("x", null, "user", { is_user_system_message: true })), false);
  assert.equal(isDisplayCandidate(node("x", null, "tool")), false);
}
console.log("trim tests: PASS");
