"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PRODUCTION_DIRS = ["chrome", "firefox"];

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.isFile() && entry.name.endsWith(".js") ? [full] : [];
  });
}

const emptyPromiseCatch = /\.catch\(\s*(?:\(\s*[^)]*\s*\)|[$A-Z_a-z][$\w]*)?\s*=>\s*\{\s*\}\s*\)/gs;
const emptyCatchBlock = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/gs;
const failures = [];

for (const directory of PRODUCTION_DIRS) {
  for (const file of jsFiles(path.join(ROOT, directory))) {
    const source = fs.readFileSync(file, "utf8");
    const relative = path.relative(ROOT, file);

    if (emptyPromiseCatch.test(source)) failures.push(`${relative}: empty Promise.catch silently hides failures`);
    emptyPromiseCatch.lastIndex = 0;

    if (emptyCatchBlock.test(source)) failures.push(`${relative}: empty catch block silently hides failures`);
    emptyCatchBlock.lastIndex = 0;
  }
}

assert.equal(
  failures.length,
  0,
  `Silent production catches are forbidden. Either expose a diagnostic, return an explicit fallback, or document/log a genuinely best-effort failure:\n${failures.join("\n")}`
);

const chromeWindowed = fs.readFileSync(path.join(ROOT, "chrome", "windowed.js"), "utf8");
const firefoxWindowed = fs.readFileSync(path.join(ROOT, "firefox", "windowed.js"), "utf8");
assert(!chromeWindowed.includes("setInterval("), "Chromium history controller must not poll forever");
assert(!firefoxWindowed.includes("setInterval("), "Firefox history controller must not poll forever");

for (const directory of PRODUCTION_DIRS) {
  const files = jsFiles(path.join(ROOT, directory));
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert(!source.includes('"visible-history"'), `${path.relative(ROOT, file)} still contains removed visible-history runtime mode`);
    assert(!source.includes('"latest-visible"'), `${path.relative(ROOT, file)} still contains removed latest-visible runtime mode`);
  }
}

console.log("code-quality tests: PASS");
