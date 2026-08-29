"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const A = require("../firefox/history-artifacts.js");

assert.equal(A.conversationId("/c/conv-123"), "conv-123");
assert.equal(A.conversationId("/branch/conv-456"), "conv-456");
assert.equal(A.normalizeSandboxPath("sandbox:/mnt/data/model.stl"), "/mnt/data/model.stl");
assert.equal(A.normalizeSandboxPath("/mnt/data/model.stl"), "/mnt/data/model.stl");
assert.equal(A.normalizeSandboxPath("sandbox:/etc/passwd"), null, "artifact resolver must remain scoped to generated /mnt/data files");
assert.equal(A.fileName("/mnt/data/hello%20world.stl"), "hello world.stl");
const url = A.requestUrl("https://chatgpt.com", "conv id", "message/id", "/mnt/data/a b.stl");
const parsed = new URL(url);
assert.equal(parsed.pathname, "/backend-api/conversation/conv%20id/interpreter/download");
assert.equal(parsed.searchParams.get("message_id"), "message/id");
assert.equal(parsed.searchParams.get("sandbox_path"), "/mnt/data/a b.stl");
assert.equal(A.retryResponse({ status: "retry" }), true);
assert.equal(A.retryResponse({ status: "success" }), false);


assert.equal(A.normalizeFileId("sediment://file_upload123"), "file_upload123");
assert.equal(A.normalizeFileId("file-service://file_upload456"), "file_upload456");
assert.equal(A.normalizeFileId("sandbox:/mnt/data/model.stl"), null);
const artifactSource = fs.readFileSync(path.join(__dirname, "..", "firefox", "history-artifacts.js"), "utf8");
assert(artifactSource.includes("/backend-api/files/download/"), "native archived file cards need ChatGPT's file download resolver");
assert(artifactSource.includes("renderFileCards"));
assert(artifactSource.includes("sandboxLinkPresent"), "assistant sandbox links must not be duplicated as generic file cards");

const markdown = fs.readFileSync(path.join(__dirname, "..", "firefox", "history-markdown.js"), "utf8");
const virtualized = fs.readFileSync(path.join(__dirname, "..", "firefox", "history-virtualized.js"), "utf8");
assert(markdown.includes("data-cg-sandbox-path") || markdown.includes("cgSandboxPath"), "Markdown renderer must identify archived sandbox links");
assert(markdown.includes("context.messageId"), "artifact links must retain their originating ChatGPT message ID");
assert(virtualized.includes("parts.push(part)"), "grouping consecutive assistant records must preserve per-message identity");
assert(!virtualized.includes('raw.text || "[Non-text visible message]"'), "empty archived assistant records must not be materialized as fake content");

console.log("archived artifact-link contracts: PASS");
