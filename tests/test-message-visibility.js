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


const upload = message("user", "", {
  id: "upload",
  contentType: "multimodal_text",
  parts: [{ content_type: "image_asset_pointer", asset_pointer: "sediment://file_upload123", mime_type: "image/png", size_bytes: 2048 }],
  metadata: { attachments: [{ id: "file_upload123", name: "reference.png", mime_type: "image/png", size_bytes: 2048 }] }
});
const uploadEntry = V.historyEntry(upload, "upload");
assert(uploadEntry, "file-only visible messages must survive history extraction");
assert.equal(uploadEntry.text, "", "structured file cards replace the generic image placeholder when a file ref survives");
assert.deepEqual(uploadEntry.attachments.map((item) => [item.fileId, item.name, item.sizeBytes]), [["file_upload123", "reference.png", 2048]]);

const recoverySequence = [
  message("user", "do task", { id: "ru" }),
  message("assistant", "", { id: "empty-run" }),
  message("user", ".", { id: "nudge" }),
  message("assistant", "resumed answer", { id: "ra" })
];
assert.equal(V.isRecoveryContinuationAt(recoverySequence, 2), true, "dot after an empty assistant and before resumed assistant is recovery plumbing");
assert.equal(V.isRecoveryContinuationAt([message("assistant", "answer"), message("user", "."), message("assistant", "next")], 1), false,
  "a dot after a substantive assistant answer must remain a real user message");

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

const recoveryMapping = {};
let recoveryParent = null;
for (const item of recoverySequence) {
  recoveryMapping[item.id] = { id: item.id, parent: recoveryParent, children: [], message: item };
  if (recoveryParent) recoveryMapping[recoveryParent].children.push(item.id);
  recoveryParent = item.id;
}
const recoveryData = { mapping: recoveryMapping, current_node: recoveryParent };
const recoveryHistory = trim.extractVisibleHistory(recoveryData);
assert.deepEqual(recoveryHistory.map((entry) => [entry.id, entry.text]), [["ru", "do task"], ["ra", "resumed answer"]]);
const recoveryTrim = trim.trimConversation(recoveryData, { maxDisplayMessages: 64 });
assert.equal(recoveryTrim.stats.displayBefore, 2, "empty response and recovery dot must not consume Performance Guard display budget");

console.log("shared visible-history policy: PASS");
