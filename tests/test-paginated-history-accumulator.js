"use strict";

const assert = require("assert");
const path = require("path");
const accumulatorApi = require(path.resolve(__dirname, "..", "firefox", "paginated-history-accumulator.js"));

function message(id, text = id) {
  return { id, role: id.startsWith("u") ? "user" : "assistant", text, createTime: null };
}

const accumulator = accumulatorApi.create({ maxPages: 4 });

let result = accumulator.observe({
  tabId: 19,
  conversationId: "conv",
  cursorRequest: false,
  nextCursor: "cursor-2",
  messages: [message("u3"), message("a3")],
  nativeVisibleCount: 2,
  pageSize: 64
});
assert.equal(result.accepted, true);
assert.equal(result.complete, false);
assert.equal(result.continueNativePagination, false, "initial page exposes its own cursor; no synthetic continuation is needed yet");
assert(result.history, "initial newest page must immediately publish a partial local archive");
assert.equal(result.history.complete, false);
assert.equal(result.history.olderPagesPending, true);
assert.deepEqual(result.history.messages.map((entry) => entry.id), ["u3", "a3"]);
assert.equal(accumulator.debug().activeCount, 1);

result = accumulator.observe({
  tabId: 19,
  conversationId: "conv",
  cursorRequest: true,
  requestCursor: "cursor-2",
  nextCursor: "cursor-1",
  messages: [message("u2"), message("a2"), message("u3", "duplicate-newest-copy")]
});
assert.equal(result.accepted, true);
assert.equal(result.complete, false);
assert.equal(result.continueNativePagination, true, "an older page that advertises another cursor must allow the native client to fetch it once");
assert(result.history, "each newly captured native page must refresh the partial archive");
assert.deepEqual(result.history.messages.map((entry) => entry.id), ["u2", "a2", "u3", "a3"]);

result = accumulator.observe({
  tabId: 19,
  conversationId: "conv",
  cursorRequest: true,
  requestCursor: "cursor-1",
  nextCursor: null,
  messages: [message("u1"), message("a1")]
});
assert.equal(result.complete, true);
assert(result.history);
assert.equal(result.history.source, "firefox-native-pagination");
assert.equal(result.history.sourcePages, 3);
assert.deepEqual(result.history.messages.map((entry) => entry.id), ["u1", "a1", "u2", "a2", "u3", "a3"]);
assert.equal(result.history.messages.find((entry) => entry.id === "u3").text, "u3", "newest page must win overlap deduplication");
assert.equal(result.history.nativeVisibleCount, 2);
assert.equal(accumulator.debug().activeCount, 0);
assert.equal(accumulator.debug().completed, 1);

// Stale/mismatched older requests must never be attached to another conversation.
result = accumulator.observe({
  tabId: 19,
  conversationId: "other",
  cursorRequest: true,
  requestCursor: "cursor-1",
  nextCursor: null,
  messages: [message("u0")]
});
assert.equal(result.accepted, false);
assert.equal(result.reason, "unexpected-page");

// Repeated server cursors fail closed instead of creating a native pagination loop.
accumulator.observe({
  tabId: 20,
  conversationId: "loop",
  cursorRequest: false,
  nextCursor: "same",
  messages: [message("u2")],
  nativeVisibleCount: 1,
  pageSize: 64
});
result = accumulator.observe({
  tabId: 20,
  conversationId: "loop",
  cursorRequest: true,
  requestCursor: "same",
  nextCursor: "same",
  messages: [message("u1")]
});
assert.equal(result.complete, false);
assert.equal(result.continueNativePagination, false);
assert.equal(result.reason, "cursor-loop");
assert.equal(accumulator.debug().activeCount, 0);
assert.equal(accumulator.debug().aborted, 1);

// A one-page conversation immediately yields a complete archive.
result = accumulator.observe({
  tabId: 21,
  conversationId: "short",
  cursorRequest: false,
  nextCursor: null,
  messages: [message("u1"), message("a1")],
  nativeVisibleCount: 2,
  pageSize: 32
});
assert.equal(result.complete, true);
assert.deepEqual(result.history.messages.map((entry) => entry.id), ["u1", "a1"]);
assert.equal(result.history.pageSize, 32);

console.log("native paginated history accumulation: PASS");
