"use strict";

const assert = require("assert");
const X = require("../firefox/export-extract.js");
const E = require("../firefox/archive-export.js");

function node(id, parent, role, text, metadata = {}, recipient = "") {
  return {
    id,
    parent,
    children: [],
    message: role ? {
      author: { role },
      recipient,
      content: { content_type: "text", parts: [text] },
      create_time: 1,
      metadata
    } : null
  };
}

function link(mapping, parent, child) {
  mapping[parent].children.push(child);
  mapping[child].parent = parent;
}

function rawConversation() {
  const mapping = { root: node("root", null, null, "") };
  let parent = "root";
  const add = (id, role, text, metadata = {}, recipient = "") => {
    mapping[id] = node(id, parent, role, text, metadata, recipient);
    link(mapping, parent, id);
    parent = id;
  };
  add("system-user", "user", "hidden system user", { is_user_system_message: true });
  add("user", "user", "Do the task");
  add("progress", "assistant", "Visible progress");
  add(
    "tool-call",
    "assistant",
    JSON.stringify({ path: "/Development_Sandbox/exec_command", args: { command: "echo old-tool" } }),
    { is_visually_hidden_from_conversation: true },
    "Development_Sandbox.exec_command"
  );
  add("tool-result", "tool", "tool result should not be exported as an assistant record");
  add("hidden-narration", "assistant", "arbitrary hidden assistant narration", { is_visually_hidden_from_conversation: true });
  add("final", "assistant", "Final answer");
  return { id: "raw-export", title: "Raw export", mapping, current_node: parent, root: "root" };
}

const archive = X.createArchive(rawConversation(), {
  id: "raw-export",
  title: "Raw export",
  sourceUrl: "https://chatgpt.com/c/raw-export",
  updatedAt: "2026-08-20T00:00:00.000Z"
});

assert(archive);
assert.equal(archive.complete, true);
assert.deepEqual(
  archive.messages.map((message) => message.id),
  ["user", "progress", "tool-call", "final"],
  "raw export must preserve visible assistant history and explicit hidden tool calls, but not hidden/system noise"
);
assert.equal(archive.messages[2].recipient, "Development_Sandbox.exec_command");
assert.equal(archive.messages[2].hidden, true);
assert(!archive.messages.some((message) => message.id === "tool-result"));
assert(!archive.messages.some((message) => message.id === "hidden-narration"));

const full = E.archiveToMarkdown(archive, { level: "full" });
const progress = E.archiveToMarkdown(archive, { level: "progress" });
const clean = E.archiveToMarkdown(archive, { level: "clean" });
assert(full.includes("old-tool"));
assert(full.includes("Visible progress"));
assert(full.includes("Final answer"));
assert(!full.includes("arbitrary hidden assistant narration"));
assert(!full.includes("tool result should not be exported"));
assert(!progress.includes("old-tool"));
assert(progress.includes("Visible progress"));
assert(clean.includes("Final answer"));
assert(!clean.includes("Visible progress"));

// Raw technical records must not break DOM-tail reconciliation. DOM turn indices
// count rendered user/assistant turns, not interleaved explicit tool records.
{
  const mapping = { root: node("root", null, null, "") };
  let parent = "root";
  const add = (id, role, text, metadata = {}, recipient = "") => {
    mapping[id] = node(id, parent, role, text, metadata, recipient);
    link(mapping, parent, id);
    parent = id;
  };
  add("u0", "user", "Task zero");
  add("p0", "assistant", "Progress zero");
  add("c0", "assistant", JSON.stringify({ path: "/tool", args: { x: 1 } }), {}, "tool.exec");
  add("a0", "assistant", "Final partial");
  const raw = X.createArchive({ id: "stream", mapping, current_node: parent, root: "root" }, {
    id: "stream", sourceUrl: "https://chatgpt.com/c/stream"
  });
  const merged = X.mergeRenderedTail(raw, [
    { role: "user", text: "Task zero", turnIndex: 0 },
    { role: "assistant", text: "Progress zero", turnIndex: 1 },
    { role: "assistant", text: "Final partial extended on screen", turnIndex: 2 }
  ]);
  assert.equal(merged.messages.find((message) => message.id === "a0").text, "Final partial extended on screen");
  assert.equal(merged.messages.find((message) => message.id === "c0").recipient, "tool.exec");
  assert.equal(merged.messages.length, 4, "tail reconciliation must not duplicate technical or visible records");
}

// A rendered turn newer than the fresh raw endpoint snapshot is appended only
// when a stable visible-turn offset anchors it.
{
  const mapping = { root: node("root", null, null, "") };
  mapping.u = node("u", "root", "user", "first"); link(mapping, "root", "u");
  mapping.a = node("a", "u", "assistant", "answer"); link(mapping, "u", "a");
  const raw = X.createArchive({ id: "lag", mapping, current_node: "a", root: "root" }, { id: "lag" });
  const merged = X.mergeRenderedTail(raw, [
    { role: "user", text: "first", turnIndex: 10 },
    { role: "assistant", text: "answer", turnIndex: 11 },
    { role: "user", text: "new live question", turnIndex: 12 }
  ]);
  assert.equal(merged.messages.at(-1).text, "new live question");
  assert.equal(merged.messages.at(-1).role, "user");
}

console.log("raw export extraction tests: PASS");
