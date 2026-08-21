"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { performance } = require("perf_hooks");

const source = fs.readFileSync(path.join(__dirname, "..", "firefox", "background.js"), "utf8");
const listeners = {};
const filters = new Map();
const session = new Map();
let tokenCounter = 0;

function eventSlot(name) {
  return { addListener(listener) { listeners[name] = listener; } };
}

const browser = {
  runtime: {
    getManifest() { return { version: "test" }; },
    onMessage: eventSlot("runtimeMessage")
  },
  storage: {
    local: {
      get(defaults) { return Promise.resolve({ ...defaults }); },
      set() { return Promise.resolve(); },
      remove() { return Promise.resolve(); }
    },
    session: {
      async get(key) { return { [key]: session.get(key) }; },
      async set(values) { for (const [key, value] of Object.entries(values)) session.set(key, value); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) session.delete(key); }
    },
    onChanged: eventSlot("storageChanged")
  },
  webRequest: {
    filterResponseData(requestId) {
      const filter = {
        error: null,
        writes: [],
        disconnected: 0,
        closed: 0,
        write(data) { this.writes.push(new Uint8Array(data).slice()); },
        disconnect() { this.disconnected++; },
        close() { this.closed++; }
      };
      filters.set(requestId, filter);
      return filter;
    },
    onBeforeRequest: eventSlot("beforeRequest"),
    onBeforeSendHeaders: eventSlot("beforeSendHeaders"),
    onHeadersReceived: eventSlot("headersReceived")
  },
  tabs: {
    sendMessage() { return Promise.resolve(); },
    onRemoved: eventSlot("tabRemoved")
  },
  action: {
    setBadgeText() { return Promise.resolve(); },
    setTitle() { return Promise.resolve(); }
  }
};

const context = {
  browser,
  console,
  URL,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  Uint32Array,
  Object,
  Array,
  Set,
  Map,
  Math,
  Date,
  Promise,
  performance,
  crypto: {
    randomUUID() { tokenCounter++; return `token-${tokenCounter}`; }
  },
  CGTrim: {
    extractVisibleHistory() { return []; },
    trimConversation(data) { return { changed: false, data, reason: "below-limit", stats: {} }; }
  },
  CGAntiCurseDiagnostics: {
    record() { return Promise.resolve(null); },
    clear() { return Promise.resolve(true); }
  }
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "firefox/background.js" });

async function issueToken(tabId, conversationId) {
  return listeners.runtimeMessage(
    { type: "cg-create-export-bypass", conversationId },
    { tab: { id: tabId } }
  );
}

function startRequest(requestId, tabId, conversationId, query = "") {
  listeners.beforeRequest({
    requestId,
    tabId,
    method: "GET",
    url: `https://chatgpt.com/backend-api/conversation/${conversationId}${query}`,
    timeStamp: Date.now()
  });
  return filters.get(requestId);
}

(async () => {
  const grant = await issueToken(7, "conv-a");
  assert.equal(grant.ok, true);
  assert.equal(grant.token, "token-1");

  const validFilter = startRequest("valid", 7, "conv-a");
  const requestHeaders = listeners.beforeSendHeaders({
    requestId: "valid",
    tabId: 7,
    url: "https://chatgpt.com/backend-api/conversation/conv-a",
    requestHeaders: [
      { name: "Accept", value: "application/json" },
      { name: "X-GPT-AntiCurse-Export", value: grant.token }
    ]
  });
  assert(requestHeaders.requestHeaders);
  assert(!requestHeaders.requestHeaders.some((header) => /gpt-anticurse-export/i.test(header.name)), "private bypass token must be stripped before network");

  const responseHeaders = listeners.headersReceived({
    requestId: "valid",
    responseHeaders: [{ name: "Content-Type", value: "application/json" }]
  });
  assert(responseHeaders.responseHeaders.some((header) => header.name === "X-GPT-AntiCurse-Export-Bypassed" && header.value === "1"), "valid one-shot bypass must be explicitly confirmed to the content script");

  validFilter.ondata({ data: new Uint8Array([1, 2, 3]).buffer });
  assert.equal(validFilter.disconnected, 1, "valid export response should detach from StreamFilter on its first data chunk");
  assert.deepEqual(Array.from(validFilter.writes[0]), [1, 2, 3], "first export chunk must be forwarded before disconnect");

  let health = await listeners.runtimeMessage({ type: "cg-background-health" }, {});
  assert.equal(health.activeResponseFilters, 0);
  assert.equal(health.pendingExportBypasses, 0);
  assert.equal(health.exportBypassDisconnects, 1);
  assert.equal(health.invalidExportBypassMarkers, 0);

  // A page cannot forge the fixed header name: an unissued value is stripped,
  // receives no confirmation, and the response remains on the normal filter path.
  const invalidFilter = startRequest("invalid", 7, "conv-a");
  const invalidRequestHeaders = listeners.beforeSendHeaders({
    requestId: "invalid",
    tabId: 7,
    url: "https://chatgpt.com/backend-api/conversation/conv-a",
    requestHeaders: [{ name: "X-GPT-AntiCurse-Export", value: "forged" }]
  });
  assert.equal(invalidRequestHeaders.requestHeaders.length, 0);
  const invalidResponseHeaders = listeners.headersReceived({
    requestId: "invalid",
    responseHeaders: [{ name: "X-GPT-AntiCurse-Export-Bypassed", value: "spoofed-by-server" }]
  });
  assert(invalidResponseHeaders.responseHeaders);
  assert(!invalidResponseHeaders.responseHeaders.some((header) => header.name.toLowerCase() === "x-gpt-anticurse-export-bypassed"), "unvalidated responses must not be able to spoof bypass confirmation");
  invalidFilter.error = "test cleanup";
  invalidFilter.onerror();

  health = await listeners.runtimeMessage({ type: "cg-background-health" }, {});
  assert.equal(health.invalidExportBypassMarkers, 1);
  assert.equal(health.activeResponseFilters, 0);

  // Cursor pagination obtains a distinct one-shot bypass for each page. Query
  // parameters must not change the conversation-id scope check.
  const page1 = await issueToken(7, "conv-pages");
  const page1Filter = startRequest("page-1", 7, "conv-pages");
  listeners.beforeSendHeaders({
    requestId: "page-1",
    tabId: 7,
    url: "https://chatgpt.com/backend-api/conversation/conv-pages",
    requestHeaders: [{ name: "X-GPT-AntiCurse-Export", value: page1.token }]
  });
  const page1Response = listeners.headersReceived({ requestId: "page-1", responseHeaders: [] });
  assert(page1Response.responseHeaders.some((header) => /Export-Bypassed/i.test(header.name)));
  page1Filter.ondata({ data: new Uint8Array([4]).buffer });

  const page2 = await issueToken(7, "conv-pages");
  assert.notEqual(page2.token, page1.token, "each cursor page must receive a fresh one-shot token");
  const page2Filter = startRequest("page-2", 7, "conv-pages", "?cursor=older-page");
  listeners.beforeSendHeaders({
    requestId: "page-2",
    tabId: 7,
    url: "https://chatgpt.com/backend-api/conversation/conv-pages?cursor=older-page",
    requestHeaders: [{ name: "X-GPT-AntiCurse-Export", value: page2.token }]
  });
  const page2Response = listeners.headersReceived({ requestId: "page-2", responseHeaders: [] });
  assert(page2Response.responseHeaders.some((header) => /Export-Bypassed/i.test(header.name)));
  page2Filter.ondata({ data: new Uint8Array([5]).buffer });

  health = await listeners.runtimeMessage({ type: "cg-background-health" }, {});
  assert.equal(health.pendingExportBypasses, 0);
  assert.equal(health.activeResponseFilters, 0);
  assert.equal(health.exportBypassDisconnects, 3, "initial valid request plus two cursor pages should each disconnect once");

  // A valid token is scoped to both tab and conversation and consumed at most once.
  const scoped = await issueToken(9, "conv-b");
  startRequest("wrong-tab", 8, "conv-b");
  listeners.beforeSendHeaders({
    requestId: "wrong-tab",
    tabId: 8,
    url: "https://chatgpt.com/backend-api/conversation/conv-b",
    requestHeaders: [{ name: "X-GPT-AntiCurse-Export", value: scoped.token }]
  });
  const wrongTabHeaders = listeners.headersReceived({ requestId: "wrong-tab", responseHeaders: [] });
  assert(!wrongTabHeaders.responseHeaders || !wrongTabHeaders.responseHeaders.some((header) => /Bypassed/i.test(header.name)));
  filters.get("wrong-tab").error = "test cleanup";
  filters.get("wrong-tab").onerror();

  console.log("Firefox one-shot export bypass tests: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
