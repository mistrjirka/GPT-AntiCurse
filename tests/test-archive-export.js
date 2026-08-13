"use strict";

const assert = require("assert");
require("../firefox/archive.js");
const A = require("../firefox/archive-export.js");

const archive = {
  schemaVersion: 1,
  id: "export-test",
  title: "Export hierarchy test",
  sourceUrl: "https://chatgpt.com/c/export-test",
  updatedAt: "2026-08-14T00:00:00.000Z",
  complete: true,
  messages: [
    { id: "u1", role: "user", text: "Do the task." },
    { id: "a1", role: "assistant", text: "I am checking the implementation now." },
    { id: "a2", role: "assistant", text: "bash -lc echo hidden-tool-call" },
    { id: "a3", role: "assistant", text: JSON.stringify({
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Patch", status: "in_progress" },
        { step: "Verify", status: "pending" }
      ],
      explanation: "Current task state."
    }) },
    { id: "a-empty", role: "assistant", text: "   " },
    { id: "a4", role: "assistant", text: "## Original response heading\n\nThe response body stays at its original Markdown hierarchy." }
  ]
};

function testProgressIsDefault() {
  assert.equal(A.DEFAULT_EXPORT_LEVEL, "progress");
  const md = A.archiveToMarkdown(archive);
  assert(md.includes("Export detail: Progress"));
  assert(md.includes("**Progress**"));
  assert(md.includes("**Plan**"));
  assert(md.includes("**Response**"));
  assert(md.includes("- [x] Inspect"));
  assert(md.includes("- [ ] **In progress:** Patch"));
  assert(md.includes("- [ ] Verify"));
  assert(md.includes("## Original response heading"));
  assert(!md.includes("### Progress"));
  assert(!md.includes("### Plan"));
  assert(!md.includes("### Final answer"));
  assert(!md.includes("hidden-tool-call"));
  assert.equal((md.match(/^## Assistant$/gm) || []).length, 1);
}

function testCleanKeepsOnlyResponse() {
  const md = A.archiveToMarkdown(archive, { level: "clean" });
  assert(md.includes("Export detail: Clean"));
  assert(md.includes("## Original response heading"));
  assert(!md.includes("I am checking the implementation now."));
  assert(!md.includes("Current task state."));
  assert(!md.includes("hidden-tool-call"));
  assert(!md.includes("**Response**"));
}

function testFullUsesLabelsNotHierarchyHeadings() {
  const md = A.archiveToMarkdown(archive, { level: "full" });
  assert(md.includes("Export detail: Full"));
  assert(md.includes("**Progress**"));
  assert(md.includes("**Plan update**"));
  assert(md.includes("**Response**"));
  assert(md.includes("**Tool call — shell**"));
  assert(md.includes("hidden-tool-call"));
  assert(md.includes("<summary>Raw plan payload</summary>"));
  assert(!md.includes("### Final answer"));
  assert(!md.includes("### Progress"));
}

const tests = [testProgressIsDefault, testCleanKeepsOnlyResponse, testFullUsesLabelsNotHierarchyHeadings];
for (const test of tests) test();
console.log(`archive export tests: PASS (${tests.length})`);
