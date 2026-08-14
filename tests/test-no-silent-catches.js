"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/gs;
const EMPTY_PROMISE_CATCH = /\.catch\s*\(\s*(?:\([^)]*\)|[$A-Z_a-z][$\w]*)?\s*=>\s*\{\s*\}\s*\)/gs;

function lineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function productionFiles(browser) {
  const directory = path.join(ROOT, browser);
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => path.join(directory, name));
}

function scanSilentCatches(file) {
  const source = fs.readFileSync(file, "utf8");
  const failures = [];
  for (const [name, pattern] of [["empty catch", EMPTY_CATCH], ["empty Promise.catch", EMPTY_PROMISE_CATCH]]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source))) failures.push(`${name} at line ${lineNumber(source, match.index)}`);
  }
  return failures;
}

const failures = [];
for (const browser of ["chrome", "firefox"]) {
  for (const file of productionFiles(browser)) {
    const relative = path.relative(ROOT, file);
    const source = fs.readFileSync(file, "utf8");

    for (const failure of scanSilentCatches(file)) failures.push(`${relative}: ${failure}`);

    if (source.includes('"visible-history"')) failures.push(`${relative}: removed visible-history runtime mode is still present`);
    if (source.includes('"latest-visible"')) failures.push(`${relative}: removed latest-visible runtime mode is still present`);
  }
}

for (const browser of ["chrome", "firefox"]) {
  const windowed = fs.readFileSync(path.join(ROOT, browser, "windowed.js"), "utf8");
  if (windowed.includes("setInterval(")) failures.push(`${browser}/windowed.js: history attachment must be event-driven, not permanent polling`);
}

assert.deepEqual(
  failures,
  [],
  `Production code-quality audit failed. Silent catches can turn a failed subsystem into invisible dead behavior; removed modes and permanent polling also create unreachable/ambiguous paths. Add explicit handling or an explanatory fallback:\n${failures.join("\n")}`
);
console.log("production code-quality audit: PASS");
