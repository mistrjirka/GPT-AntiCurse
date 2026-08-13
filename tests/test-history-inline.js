"use strict";
const assert = require("assert");
const fs = require("fs");

const history = fs.readFileSync(require.resolve("../firefox/history-overlay.js"), "utf8");
const windowed = fs.readFileSync(require.resolve("../firefox/windowed.js"), "utf8");

assert(!history.includes("position: fixed; inset: 0"), "history must not use a full-screen overlay");
assert(history.includes('document.querySelector("#thread")'), "inline history must anchor to ChatGPT #thread");
assert(history.includes('insertBefore(this.host, thread)'), "inline history must render immediately before native #thread");
assert(history.includes("Load previous ${nextCount}"), "fixed modes need an inline Load previous button");
assert(history.includes("content-visibility: auto"), "archived turns should stay lightweight off-screen");
assert(windowed.includes('settings.mode === "windowed-visible"'), "auto mode must remain explicit");
assert(windowed.includes("loadPreviousPage(true)"), "auto mode must load inline pages instead of opening an overlay");
assert(!windowed.includes("reader.open()"), "windowed controller must not open the old overlay");
console.log("inline history tests: PASS");
