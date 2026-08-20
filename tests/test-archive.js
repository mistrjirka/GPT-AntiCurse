"use strict";

const assert = require("assert");
require("../firefox/trim.js");
require("../firefox/trim-logical.js");
require("../firefox/trim-pipeline.js");
const A = require("../firefox/archive.js");
const E = require("../firefox/archive-export.js");

function n(id, parent, role, text, metadata = {}) {
  return {
    id,
    parent,
    children: [],
    message: role ? {
      author: { role },
      content: { content_type: "text", parts: [text] },
      create_time: 1,
      metadata
    } : null
  };
}

function conversation() {
  const mapping = { root: n("root", null, null, "") };
  mapping.m0 = n("m0", "root", "user", "hello");
  mapping.root.children.push("m0");
  mapping.hidden = n("hidden", "m0", "assistant", "secret", { is_visually_hidden_from_conversation: true });
  mapping.m0.children.push("hidden");
  mapping.m1 = n("m1", "hidden", "assistant", "world");
  mapping.hidden.children.push("m1");
  return { id: "conv-test", title: "Archive test", mapping, current_node: "m1", root: "root" };
}

function testUrlAndAuthoritativeArchive() {
  assert.equal(A.conversationIdFromUrl("https://chatgpt.com/c/abc"), "abc");
  assert.equal(A.conversationIdFromUrl("https://chatgpt.com/g/example/c/def"), "def");
  assert.equal(A.archiveToMarkdown, undefined, "archive core must not carry a second Markdown exporter");

  const archive = A.createArchive(conversation(), {
    sourceUrl: "https://chatgpt.com/c/conv-test",
    updatedAt: "2026-08-13T12:00:00.000Z"
  });
  assert.equal(archive.messages.length, 2);
  assert.deepEqual(archive.messages.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(archive.messages.map((message) => message.text), ["hello", "world"]);
  assert(!E.archiveToMarkdown(archive).includes("secret"));
}

function testMarkdownStructureAndRichText() {
  const archive = {
    schemaVersion: 1,
    id: "rich",
    title: "Markdown λ test",
    sourceUrl: "https://chatgpt.com/c/rich",
    updatedAt: "2026-08-13T12:34:56.000Z",
    complete: true,
    messages: [
      { id: "u", role: "user", text: "Unicode: čeština λ\n\n```bash\necho hello\n```", createTime: 1 },
      { id: "a", role: "assistant", text: "- first\n- second\n\n**bold stays Markdown**", createTime: 2 }
    ]
  };

  const markdown = E.archiveToMarkdown(archive);
  assert(markdown.startsWith("# Markdown λ test\n\n"));
  assert(markdown.includes("> Exported by GPT AntiCurse on 2026-08-13T12:34:56.000Z."));
  assert(markdown.includes("> Original conversation: https://chatgpt.com/c/rich"));
  assert(markdown.includes("## User\n\nUnicode: čeština λ\n\n```bash\necho hello\n```"));
  assert(markdown.includes("## Assistant\n\n- first\n- second\n\n**bold stays Markdown**"));
  assert.equal((markdown.match(/^## User$/gm) || []).length, 1);
  assert.equal((markdown.match(/^## Assistant$/gm) || []).length, 1);
  assert(markdown.endsWith("\n"));
}

function testPartialWarningAndFilename() {
  const partial = {
    id: "partial",
    title: "Bad / name: \"x\"? <y> | λ",
    sourceUrl: "https://chatgpt.com/c/partial",
    updatedAt: "2026-08-13T12:00:00.000Z",
    complete: false,
    messages: [{ role: "user", text: "visible tail" }]
  };

  const markdown = E.archiveToMarkdown(partial);
  assert(markdown.includes("Warning: this export snapshot was reconstructed from currently rendered turns"));

  const filename = A.archiveFilename(partial);
  assert(filename.endsWith(".md"));
  assert(!/[\\/:*?"<>|\u0000-\u001f]/.test(filename));
  assert(filename.includes("λ"));
}

function testRenderedMergeAndStreamingExtension() {
  const archive = A.createArchive(conversation(), { sourceUrl: "https://chatgpt.com/c/conv-test" });
  const merged = A.mergeArchiveWithRendered(archive, [
    { role: "assistant", text: "world", turnIndex: 1 },
    { role: "user", text: "next", turnIndex: 2 }
  ]);
  assert.equal(merged.messages.length, 3);
  assert.equal(merged.messages[2].text, "next");

  const streaming = {
    schemaVersion: 1,
    id: "stream",
    title: "stream",
    sourceUrl: "https://chatgpt.com/c/stream",
    updatedAt: "2026-08-13T12:00:00.000Z",
    complete: true,
    messages: [
      { id: "u", role: "user", text: "question", createTime: 1 },
      { id: "a", role: "assistant", text: "partial", createTime: 2 }
    ]
  };
  const extended = A.mergeArchiveWithRendered(streaming, [
    { role: "assistant", text: "partial response complete", turnIndex: 1 }
  ]);
  assert.equal(extended.messages.length, 2);
  assert.equal(extended.messages[1].text, "partial response complete");
}

function testNetworkRefreshPreservesNewerTail() {
  const network = {
    schemaVersion: 1,
    id: "network",
    title: "Network",
    sourceUrl: "https://chatgpt.com/c/network",
    updatedAt: "2026-08-13T12:00:00.000Z",
    complete: true,
    messages: [
      { id: "u", role: "user", text: "one", createTime: 1 },
      { id: "a", role: "assistant", text: "two", createTime: 2 }
    ]
  };
  const existing = {
    ...network,
    messages: network.messages.concat({ id: "u2", role: "user", text: "three", createTime: 3 })
  };
  const merged = A.mergeNetworkArchive(existing, network);
  assert.deepEqual(merged.messages.map((message) => message.text), ["one", "two", "three"]);
}

function testLongMarkdownOrderAndSummary() {
  const messages = Array.from({ length: 300 }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 ? "assistant" : "user",
    text: `unique-message-${index}`,
    createTime: index
  }));
  const archive = {
    schemaVersion: 1,
    id: "long",
    title: "Long export",
    sourceUrl: "https://chatgpt.com/c/long",
    updatedAt: "2026-08-13T12:00:00.000Z",
    complete: true,
    messages
  };

  const markdown = E.archiveToMarkdown(archive);
  assert(markdown.indexOf("unique-message-0") < markdown.indexOf("unique-message-299"));
  assert.equal((markdown.match(/^## (User|Assistant)$/gm) || []).length, 300);

  const summary = A.archiveSummary(archive);
  assert.equal(summary.messageCount, 300);
  assert.equal(summary.characters, messages.reduce((sum, message) => sum + message.text.length, 0));
}

const tests = [
  testUrlAndAuthoritativeArchive,
  testMarkdownStructureAndRichText,
  testPartialWarningAndFilename,
  testRenderedMergeAndStreamingExtension,
  testNetworkRefreshPreservesNewerTail,
  testLongMarkdownOrderAndSummary
];

for (const test of tests) test();
console.log(`archive tests: PASS (${tests.length})`);
