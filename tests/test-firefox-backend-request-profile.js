"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const endpoint = require("../firefox/conversation-endpoint.js");

const source = fs.readFileSync(path.join(__dirname, "../firefox/backend-request-profile.js"), "utf8");
const storage = {};
const listeners = { beforeHeaders: null, headersReceived: null, completed: null, error: null, installed: null };
const filters = {};

const browser = {
  runtime: {
    getManifest: () => ({ version: "0.7.3" }),
    onInstalled: { addListener: (listener) => { listeners.installed = listener; } }
  },
  storage: {
    local: {
      get: async (defaults) => ({ ...defaults, ...storage }),
      set: async (value) => Object.assign(storage, value),
      remove: async (key) => { delete storage[key]; }
    }
  },
  webRequest: {
    onBeforeSendHeaders: {
      addListener: (listener, filter, extraInfoSpec) => {
        listeners.beforeHeaders = listener;
        filters.beforeHeaders = filter;
        filters.beforeHeadersExtra = extraInfoSpec;
      }
    },
    onHeadersReceived: {
      addListener: (listener, filter, extraInfoSpec) => {
        listeners.headersReceived = listener;
        filters.headersReceived = filter;
        filters.headersReceivedExtra = extraInfoSpec;
      }
    },
    onCompleted: {
      addListener: (listener, filter) => {
        listeners.completed = listener;
        filters.completed = filter;
      }
    },
    onErrorOccurred: {
      addListener: (listener, filter) => {
        listeners.error = listener;
        filters.error = filter;
      }
    }
  }
};

const context = {
  browser,
  URL,
  Date,
  console,
  setTimeout,
  clearTimeout,
  CGConversationEndpoint: endpoint
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "backend-request-profile.js" });

const profiler = context.CGAntiCurseBackendRequestProfiler;
assert(profiler, "profiler should be exported for diagnostics/tests");
assert.deepEqual(filters.beforeHeaders.urls, ["https://chatgpt.com/backend-api/*"]);
assert.deepEqual(Array.from(filters.beforeHeadersExtra), ["requestHeaders"]);
assert.deepEqual(filters.headersReceived.urls, ["https://chatgpt.com/backend-api/*"]);
assert.deepEqual(Array.from(filters.headersReceivedExtra), ["responseHeaders"]);
assert.deepEqual(filters.completed.urls, ["https://chatgpt.com/backend-api/*"]);
assert.deepEqual(filters.error.urls, ["https://chatgpt.com/backend-api/*"]);
assert.equal(profiler.normalizedRetryAfter("17"), 17);
assert.equal(profiler.normalizedRetryAfter("99999"), 3600);
assert.equal(profiler.normalizedRetryAfter("not-a-delay"), null);

const singular = "https://chatgpt.com/backend-api/conversation/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?cursor=secret-cursor";
assert.equal(profiler.routeFromUrl(singular), "/backend-api/conversation/:id");
assert.equal(profiler.isConversationTarget(singular), true);
assert.deepEqual(Array.from(profiler.queryKeysFromUrl(singular)), ["cursor"]);

const plural = "https://chatgpt.com/backend-api/conversations/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?num_turns=10&include_has_versions=true&cursor=secret";
assert.equal(profiler.routeFromUrl(plural), "/backend-api/conversations/:id");
assert.equal(profiler.isConversationTarget(plural), true);
assert.deepEqual(Array.from(profiler.queryKeysFromUrl(plural)), ["cursor", "include_has_versions", "num_turns"]);

const featureConversation = "https://chatgpt.com/backend-api/f/conversation?conversation_id=super-secret-id";
assert.equal(profiler.routeFromUrl(featureConversation), "/backend-api/f/conversation");
assert.equal(profiler.isConversationTarget(featureConversation), false);
assert.deepEqual(Array.from(profiler.queryKeysFromUrl(featureConversation)), ["conversation_id"]);

const feedback = "https://chatgpt.com/backend-api/implicit_message_feedback";
assert.equal(profiler.routeFromUrl(feedback), "/backend-api/implicit_message_feedback");
assert.equal(profiler.isConversationTarget(feedback), false);

const unknownTail = "https://chatgpt.com/backend-api/accounts/account-value-that-must-not-be-exported/settings";
assert.equal(profiler.routeFromUrl(unknownTail), "/backend-api/accounts/:tail");
assert(!profiler.routeFromUrl(unknownTail).includes("account-value"));

listeners.completed({
  requestId: "feature",
  tabId: 11,
  url: featureConversation,
  method: "GET",
  statusCode: 200,
  type: "xmlhttprequest"
});
listeners.beforeHeaders({
  requestId: "export",
  tabId: 12,
  url: singular,
  requestHeaders: [{ name: "X-GPT-AntiCurse-Export", value: "private-token-must-not-be-stored" }]
});
listeners.headersReceived({
  requestId: "export",
  tabId: 12,
  url: singular,
  statusCode: 429,
  responseHeaders: [{ name: "Retry-After", value: "17" }]
});
listeners.completed({
  requestId: "export",
  tabId: 12,
  url: singular,
  method: "GET",
  statusCode: 429,
  type: "xmlhttprequest"
});
listeners.completed({
  requestId: "plural",
  tabId: 11,
  url: plural,
  method: "GET",
  statusCode: 200,
  type: "xmlhttprequest"
});
listeners.error({
  requestId: "feedback",
  tabId: 11,
  url: feedback,
  method: "POST",
  error: "NS_BINDING_ABORTED",
  type: "xmlhttprequest"
});

(async () => {
  await profiler.flush();
  const profile = storage.cgBackendRequestProfile;
  assert(profile, "profile should be persisted");
  assert.equal(profile.profileVersion, 3);
  assert.equal(profile.total, 4);
  assert.equal(profile.completed, 3);
  assert.equal(profile.failed, 1);
  assert.equal(profile.conversationTargets, 2);
  assert.equal(profile.nonConversationTargets, 2);
  assert.equal(profile.sources["anticurse-export"], 1);
  assert.equal(profile.sources.unmarked, 3);
  assert.equal(profile.tabs["12"].total, 1);
  assert.equal(profile.tabs["12"].conversationTargets, 1);
  assert.equal(profile.tabs["12"].rateLimited, 1);
  assert.equal(profile.tabs["11"].total, 3);
  assert.equal(profile.tabs["11"].rateLimited, 0);

  const serialized = JSON.stringify(profile);
  assert(serialized.includes("anticurse-export"));
  assert(serialized.includes('"retryAfterSeconds":[17]'));
  assert(serialized.includes("/backend-api/f/conversation"));
  assert(serialized.includes("/backend-api/conversations/:id"));
  assert(serialized.includes("/backend-api/implicit_message_feedback"));
  assert(!serialized.includes("private-token-must-not-be-stored"));
  assert(!serialized.includes("super-secret-id"));
  assert(!serialized.includes("secret-cursor"));
  assert(!serialized.includes("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
  assert(!serialized.includes("account-value-that-must-not-be-exported"));

  assert.equal(typeof listeners.installed, "function");
  listeners.installed({ reason: "update" });
  await profiler.flush();
  assert.equal(storage.cgBackendRequestProfile, undefined);

  console.log("firefox backend request profile: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
