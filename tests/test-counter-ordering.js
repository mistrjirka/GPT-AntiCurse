"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "chrome", "background.js"), "utf8");
const EMPTY = {
  responsesTrimmed: 0,
  nodesRemoved: 0,
  nodesDelivered: 0,
  visibleTurnsKept: 0,
  inputBytes: 0,
  outputBytes: 0,
  bytesRemoved: 0
};

let listener = null;
const stored = { cgTotals: { ...EMPTY } };
const pendingSets = [];

const chrome = {
  storage: {
    local: {
      async get(defaults) {
        return { ...defaults, ...stored };
      },
      set(value) {
        return new Promise((resolve) => {
          pendingSets.push({
            value,
            commit() {
              Object.assign(stored, value);
              resolve();
            }
          });
        });
      }
    }
  },
  runtime: {
    onMessage: {
      addListener(fn) { listener = fn; }
    }
  }
};

const context = {
  chrome,
  console,
  CGArchiveStore: { async get() { return null; } },
  CGAntiCurseDiagnostics: { record() { return Promise.resolve(null); } }
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "chrome/background.js" });
assert(listener, "background listener should register");

function send(message) {
  return new Promise((resolve) => {
    assert.equal(listener(message, {}, resolve), true);
  });
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  const update = send({
    type: "cg-record-stats",
    stats: {
      mode: "trimmed",
      mappingNodesBefore: 20,
      mappingNodesAfter: 5,
      discardedNodes: 15,
      displayAfter: 4,
      originalBytes: 1000,
      outputBytes: 250
    }
  });

  await tick();
  assert.equal(pendingSets.length, 1, "counter update should reach its persistence write");

  const reset = send({ type: "cg-reset-totals" });
  await tick();
  assert.equal(
    pendingSets.length,
    1,
    "reset must wait behind the in-flight counter update instead of racing its storage write"
  );

  pendingSets.shift().commit();
  await update;
  await tick();
  assert.equal(pendingSets.length, 1, "reset write should start only after the older update completes");

  pendingSets.shift().commit();
  const resetValue = await reset;
  assert.equal(resetValue.responsesTrimmed, 0);
  assert.equal(stored.cgTotals.responsesTrimmed, 0, "late completion must not resurrect counters after reset");
  assert.equal(stored.cgTotals.nodesRemoved, 0);

  console.log("counter ordering tests: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
