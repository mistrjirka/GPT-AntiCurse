/* Stop native ChatGPT conversation-document retry storms from hammering the backend after HTTP 429. */
"use strict";

(() => {
  const ENDPOINT = globalThis.CGConversationEndpoint;
  if (!ENDPOINT || typeof ENDPOINT.conversationId !== "function") return;

  const BASE_DELAY_MS = 15_000;
  const MAX_DELAY_MS = 300_000;
  const EXPORT_HEADER = "x-gpt-anticurse-export";
  const states = new Map();
  let blockedRequests = 0;
  let observed429s = 0;
  let successfulResets = 0;

  function keyFor(details) {
    if (!details || !Number.isInteger(details.tabId) || details.tabId < 0) return null;
    const id = ENDPOINT.conversationId(details.url);
    return id ? `${details.tabId}:${id}` : null;
  }

  function retryAfterMs(headers) {
    if (!Array.isArray(headers)) return 0;
    const header = headers.find((entry) => String(entry && entry.name || "").toLowerCase() === "retry-after");
    const raw = String(header && header.value || "").trim();
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_DELAY_MS, seconds * 1000);
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, Math.min(MAX_DELAY_MS, date - Date.now())) : 0;
  }

  function activeState(key, now = Date.now()) {
    const state = key && states.get(key);
    if (!state) return null;
    if (state.until > now) return state;
    return null;
  }

  function note429(key, headers, now = Date.now()) {
    if (!key) return null;
    const previous = states.get(key);
    const failures = Math.min(8, Math.max(0, Number(previous && previous.failures) || 0) + 1);
    const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * (2 ** (failures - 1)));
    const delayMs = Math.max(exponential, retryAfterMs(headers));
    const state = { failures, delayMs, until: now + delayMs, lastStatus: 429 };
    states.set(key, state);
    observed429s++;
    return state;
  }

  function noteSuccess(key) {
    if (!key || !states.has(key)) return false;
    states.delete(key);
    successfulResets++;
    return true;
  }

  function requestHasExportMarker(details) {
    const headers = Array.isArray(details && details.requestHeaders) ? details.requestHeaders : [];
    return headers.some((entry) => String(entry && entry.name || "").toLowerCase() === EXPORT_HEADER && String(entry.value || "").trim());
  }

  function guardRequest(details) {
    if (!details || details.method !== "GET") return {};
    const key = keyFor(details);
    if (!key || requestHasExportMarker(details)) return {};
    const state = activeState(key);
    if (!state) return {};
    blockedRequests++;
    return { cancel: true };
  }

  function observeResponse(details) {
    if (!details || details.method !== "GET") return {};
    const key = keyFor(details);
    if (!key) return {};
    const status = Number(details.statusCode) || 0;
    if (status === 429) note429(key, details.responseHeaders);
    else if (status >= 200 && status < 300) noteSuccess(key);
    return {};
  }

  browser.webRequest.onBeforeSendHeaders.addListener(
    guardRequest,
    { urls: ["https://chatgpt.com/backend-api/conversation/*", "https://chatgpt.com/backend-api/conversations/*"] },
    ["blocking", "requestHeaders"]
  );

  browser.webRequest.onHeadersReceived.addListener(
    observeResponse,
    { urls: ["https://chatgpt.com/backend-api/conversation/*", "https://chatgpt.com/backend-api/conversations/*"] },
    ["responseHeaders"]
  );

  globalThis.CGAntiCurseConversationRateLimitGuard = Object.freeze({
    activeStateFor(tabId, conversationId) {
      const key = `${Number(tabId)}:${String(conversationId || "")}`;
      const state = activeState(key);
      return state ? { ...state, retryInMs: Math.max(1, state.until - Date.now()) } : null;
    },
    debug() {
      const now = Date.now();
      const active = [];
      for (const [key, state] of states) {
        if (state.until <= now) continue;
        active.push({ key, failures: state.failures, retryInMs: state.until - now });
      }
      return { blockedRequests, observed429s, successfulResets, active };
    },
    _test: { retryAfterMs, activeState, note429, noteSuccess }
  });
})();
