"use strict";

const assert = require("assert");
const path = require("path");

const firewall = require(path.resolve(__dirname, "..", "chrome", "pagination-firewall.js"));

function sample(cursor = null) {
  return {
    id: "conversation",
    title: "Conversation",
    mapping: {
      a: { id: "a", parent: null, children: ["b"] },
      b: { id: "b", parent: "a", children: [] }
    },
    current_node: "b",
    cursor
  };
}

{
  const input = sample("older-page");
  const result = firewall.apply(input, { cursorRequest: false });
  assert.equal(result.changed, true);
  assert.equal(result.reason, "cursor-suppressed");
  assert.equal(result.remoteCursor, "older-page");
  assert.equal(result.data.cursor, null, "ChatGPT must see a terminated cursor");
  assert.strictEqual(result.data.mapping, input.mapping, "cursor suppression must not clone/rebuild the graph");
  assert.equal(result.data.current_node, "b");
  assert.equal(result.stats.paginationCursorSuppressed, true);
  assert.equal(input.cursor, "older-page", "the untouched source cursor must remain available to the private bridge");
}

{
  const input = sample(null);
  const result = firewall.apply(input, { cursorRequest: false });
  assert.equal(result.changed, false);
  assert.strictEqual(result.data, input);
  assert.equal(result.reason, "no-cursor");
}

{
  const input = sample("next-older-page");
  const result = firewall.apply(input, { cursorRequest: true });
  assert.equal(result.changed, true);
  assert.equal(result.reason, "older-page-blocked");
  assert.equal(result.remoteCursor, "next-older-page");
  assert.deepEqual(result.data.mapping, {}, "raw older page graph nodes must never accumulate in React state");
  assert.equal(result.data.cursor, null);
  assert.equal(result.stats.paginationBlockedNodes, 2);
}

for (const input of [null, {}, { mapping: [] }, { mapping: "unexpected", cursor: "keep-me" }]) {
  const result = firewall.apply(input, { cursorRequest: true });
  assert.equal(result.changed, false, "unknown response shapes must fail open");
  assert.strictEqual(result.data, input);
  assert.equal(result.reason, "unsupported-shape");
}

{
  const unfamiliarInitial = { mapping: { a: { id: "a" } }, cursor: "keep-private-only-if-known" };
  const result = firewall.apply(unfamiliarInitial, { cursorRequest: false });
  assert.equal(result.changed, false, "mapping-like initial pages without a valid current_node must fail open");
  assert.strictEqual(result.data, unfamiliarInitial);
  assert.equal(result.reason, "unsupported-shape");
}

assert.equal(firewall.isCursorRequest("https://chatgpt.com/backend-api/conversation/x?cursor=abc"), true);
assert.equal(firewall.isCursorRequest("https://chatgpt.com/backend-api/conversation/x?foo=cursor"), false);
assert.equal(firewall.isCursorRequest("not a valid url but cursor-like"), false);

console.log("pagination firewall unit tests: PASS");
