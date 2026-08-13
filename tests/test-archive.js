"use strict";
const assert = require("assert");
require("../firefox/trim.js");
const A = require("../firefox/archive.js");

function n(id, parent, role, text, metadata = {}) {
  return { id, parent, children: [], message: role ? { author: { role }, content: { content_type: "text", parts: [text] }, create_time: 1, metadata } : null };
}
function conversation() {
  const mapping = { root: n("root", null, null, "") };
  let parent = "root";
  [["user", "hello"], ["assistant", "world"]].forEach(([role, text], i) => {
    const id = `m${i}`;
    mapping[id] = n(id, parent, role, text);
    mapping[parent].children.push(id);
    parent = id;
  });
  mapping.hidden = n("hidden", parent, "assistant", "secret", { is_visually_hidden_from_conversation: true });
  mapping[parent].children.push("hidden");
  return { id: "conv-test", title: "Archive test", mapping, current_node: parent, root: "root" };
}

assert.equal(A.conversationIdFromUrl("https://chatgpt.com/c/abc"), "abc");
const archive = A.createArchive(conversation(), { sourceUrl: "https://chatgpt.com/c/conv-test" });
assert.equal(archive.messages.length, 2);
assert(!A.archiveToMarkdown(archive).includes("secret"));
const merged = A.mergeArchiveWithRendered(archive, [
  { role: "assistant", text: "world", turnIndex: 1 },
  { role: "user", text: "next", turnIndex: 2 }
]);
assert.equal(merged.messages.length, 3);
assert.equal(merged.messages[2].text, "next");
console.log("archive tests: PASS");
