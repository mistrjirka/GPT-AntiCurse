"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EMPTY_CATCH = /catch\s*\([^)]*\)\s*\{\s*\}/g;
const EMPTY_PROMISE_CATCH = /\.catch\s*\(\s*\([^)]*\)\s*=>\s*\{\s*\}\s*\)/g;

function lineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function scanFile(file) {
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
  const dir = path.join(ROOT, browser);
  for (const name of fs.readdirSync(dir).filter((item) => item.endsWith(".js")).sort()) {
    for (const failure of scanFile(path.join(dir, name))) failures.push(`${browser}/${name}: ${failure}`);
  }
}

assert.deepEqual(
  failures,
  [],
  `Silent catches can turn a failed subsystem into invisible dead behavior. Add explicit handling or an explanatory best-effort catch:\n${failures.join("\n")}`
);
console.log("silent-catch audit: PASS");
