"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "chrome", "diagnostics.js"), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  const state = { cgIssueHistory: [] };
  const firstSetGate = deferred();
  let blockFirstSet = true;

  const local = {
    async get(defaults) {
      const result = { ...defaults };
      for (const key of Object.keys(defaults || {})) {
        if (Object.prototype.hasOwnProperty.call(state, key)) result[key] = state[key];
      }
      return result;
    },
    async set(values) {
      if (blockFirstSet) {
        blockFirstSet = false;
        await firstSetGate.promise;
      }
      Object.assign(state, values);
    },
    async remove(key) {
      for (const item of Array.isArray(key) ? key : [key]) delete state[item];
    }
  };

  const context = {
    chrome: { storage: { local } },
    console: { warn() {}, error() {}, debug() {} },
    Date,
    Promise,
    Object,
    String,
    Number,
    Array
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "diagnostics.js" });
  const diagnostics = context.CGAntiCurseDiagnostics;

  const record = diagnostics.record("history", "transient", "temporary failure");
  await settle();
  const clear = diagnostics.clear("history", "transient");
  await settle();

  firstSetGate.resolve();
  await record;
  assert.equal(await clear, true, "clear should run after the pending diagnostic write");
  assert.equal(state.cgLastIssue, undefined, "a stale pending diagnostic must not reappear after clear");
  assert.equal(state.cgIssueHistory.length, 1, "clearing current status should retain bounded diagnostic history");

  console.log("diagnostic ordering tests: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
