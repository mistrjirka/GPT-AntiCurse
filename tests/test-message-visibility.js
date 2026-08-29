"use strict";

const assert = require("assert");
const V = require("../firefox/message-visibility.js");

function message(role, text, options = {}) {
  return {
    id: options.id || "m",
    author: { role },
    content: {
      content_type: options.contentType || "text",
      parts: options.parts || [text]
    },
    metadata: options.metadata || {},
    recipient: options.recipient || "",
    channel: options.channel || undefined,
    create_time: 1
  };
}

assert(V.historyEntry(message("user", "hello"), "u"));
assert(V.historyEntry(message("assistant", "answer"), "a"));
assert.equal(V.historyEntry(message("assistant", ""), "empty"), null, "empty assistant records must not create synthetic turns");
assert.equal(V.historyEntry(message("assistant", "secret", { metadata: { is_visually_hidden_from_conversation: true } }), "hidden"), null);
assert.equal(V.historyEntry(message("assistant", "tool args", { recipient: "Development_Sandbox.exec_command" }), "tool"), null);
assert.equal(V.historyEntry(message("assistant", "private chain", { contentType: "thoughts" }), "thoughts"), null);
assert.equal(V.historyEntry(message("assistant", "private recap", { contentType: "reasoning_recap" }), "recap"), null);
assert.equal(V.historyEntry(message("assistant", "private analysis", { channel: "analysis" }), "analysis"), null);
assert.equal(V.historyEntry(message("assistant", "private analysis", { metadata: { channel: "analysis" } }), "analysis-meta"), null);

const image = message("assistant", "", {
  id: "image",
  parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://example" }]
});
const imageEntry = V.historyEntry(image, "image");
assert(imageEntry && imageEntry.text === "[Image / attachment]", "real non-text visible content must remain represented");

const trim = require("../firefox/trim.js");
const mapping = {
  u: { id: "u", parent: null, children: ["thinking"], message: message("user", "hello", { id: "u" }) },
  thinking: { id: "thinking", parent: "u", children: ["tool"], message: message("assistant", "private chain", { id: "thinking", contentType: "thoughts" }) },
  tool: { id: "tool", parent: "thinking", children: ["empty"], message: message("assistant", "tool args", { id: "tool", recipient: "tool.exec" }) },
  empty: { id: "empty", parent: "tool", children: ["a"], message: message("assistant", "", { id: "empty" }) },
  a: { id: "a", parent: "empty", children: [], message: message("assistant", "answer", { id: "a" }) }
};
const history = trim.extractVisibleHistory({ mapping, current_node: "a" });
assert.deepEqual(history.map((entry) => [entry.id, entry.text]), [["u", "hello"], ["a", "answer"]]);

console.log("shared visible-history policy: PASS");
