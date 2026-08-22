/*
 * Temporary Firefox live-site request profiler.
 *
 * Records only coarse backend route metadata, request methods, status codes,
 * query parameter NAMES, tab-local numeric IDs, normalized Retry-After delays,
 * and whether AntiCurse would treat the request as a conversation document.
 * It never reads request/response bodies, arbitrary header values, query values,
 * conversation IDs, or conversation text.
 */
"use strict";

(() => {
  const STORAGE_KEY = "cgBackendRequestProfile";
  const PROFILE_VERSION = 3;
  const MAX_RECENT = 100;
  const MAX_GROUPS = 200;
  const FLUSH_DELAY_MS = 250;
  const EXPORT_HEADER_NAME = "x-gpt-anticurse-export";
  const ENDPOINT = globalThis.CGConversationEndpoint;
  const extensionVersion = browser.runtime.getManifest().version;
  const requestSources = new Map();
  const responseMeta = new Map();
  let writeQueue = Promise.resolve();
  let pendingEvents = [];
  let flushTimer = null;

  function isoNow() {
    return new Date().toISOString();
  }

  function safeEndpointName(value) {
    const text = String(value || "");
    return /^[a-z][a-z0-9_-]{0,47}$/.test(text) ? text : "other";
  }

  function routeFromUrl(urlString) {
    let url;
    try {
      url = new URL(urlString);
    } catch (_error) {
      return null;
    }
    if (url.origin !== "https://chatgpt.com" || !url.pathname.startsWith("/backend-api/")) return null;

    const parts = url.pathname.slice("/backend-api/".length).split("/").filter(Boolean);
    if (!parts.length) return "/backend-api/";

    const first = safeEndpointName(parts[0]);
    if ((first === "conversation" || first === "conversations") && parts.length > 1) {
      return `/backend-api/${first}/:id${parts.length > 2 ? "/:tail" : ""}`;
    }
    if (first === "f") {
      const second = parts.length > 1 ? safeEndpointName(parts[1]) : null;
      return second
        ? `/backend-api/f/${second}${parts.length > 2 ? "/:tail" : ""}`
        : "/backend-api/f";
    }
    return `/backend-api/${first}${parts.length > 1 ? "/:tail" : ""}`;
  }

  function queryKeysFromUrl(urlString) {
    try {
      const url = new URL(urlString);
      const keys = new Set();
      for (const key of url.searchParams.keys()) keys.add(safeEndpointName(key));
      return Array.from(keys).sort().slice(0, 24);
    } catch (_error) {
      return [];
    }
  }

  function isConversationTarget(urlString) {
    if (!ENDPOINT || typeof ENDPOINT.conversationId !== "function") return false;
    return !!ENDPOINT.conversationId(urlString);
  }

  function normalizedRetryAfter(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    if (/^\d{1,5}$/.test(raw)) return Math.max(0, Math.min(3600, Number(raw)));
    const timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp)) return null;
    return Math.max(0, Math.min(3600, Math.ceil((timestamp - Date.now()) / 1000)));
  }

  function sourceForRequest(details, route) {
    const explicit = details && details.requestId ? requestSources.get(details.requestId) : null;
    if (explicit) return explicit;
    if (route && route.startsWith("/backend-api/conversation/:id/:tail")) return "chatgpt-or-anticurse-status";
    return "unmarked";
  }

  function classify(details, outcome) {
    const route = routeFromUrl(details && details.url);
    if (!route) return null;
    const method = String(details && details.method || "UNKNOWN").toUpperCase().slice(0, 16);
    const statusCode = Number.isInteger(details && details.statusCode) ? details.statusCode : null;
    const error = outcome === "error" && details && details.error
      ? String(details.error).slice(0, 120)
      : null;
    const meta = details && details.requestId ? responseMeta.get(details.requestId) : null;
    return {
      at: isoNow(),
      tabId: Number.isInteger(details && details.tabId) ? details.tabId : -1,
      method,
      route,
      queryKeys: queryKeysFromUrl(details.url),
      conversationTarget: isConversationTarget(details.url),
      source: sourceForRequest(details, route),
      outcome,
      statusCode,
      retryAfterSeconds: meta && Number.isFinite(meta.retryAfterSeconds) ? meta.retryAfterSeconds : null,
      error,
      requestType: details && details.type ? String(details.type).slice(0, 40) : null
    };
  }

  function emptyProfile() {
    const now = isoNow();
    return {
      profileVersion: PROFILE_VERSION,
      extensionVersion,
      privacy: "metadata-only; no bodies, arbitrary header values, query values, conversation IDs, or conversation text",
      startedAt: now,
      updatedAt: now,
      total: 0,
      completed: 0,
      failed: 0,
      conversationTargets: 0,
      nonConversationTargets: 0,
      sources: {},
      tabs: {},
      groups: {},
      recent: []
    };
  }

  function normalizeProfile(value) {
    if (!value || typeof value !== "object" || value.profileVersion !== PROFILE_VERSION || value.extensionVersion !== extensionVersion) {
      return emptyProfile();
    }
    return {
      ...emptyProfile(),
      ...value,
      sources: value.sources && typeof value.sources === "object" && !Array.isArray(value.sources) ? value.sources : {},
      tabs: value.tabs && typeof value.tabs === "object" && !Array.isArray(value.tabs) ? value.tabs : {},
      groups: value.groups && typeof value.groups === "object" && !Array.isArray(value.groups) ? value.groups : {},
      recent: Array.isArray(value.recent) ? value.recent.slice(-MAX_RECENT) : []
    };
  }

  const profileReady = browser.storage.local.get({ [STORAGE_KEY]: null }).then((saved) => normalizeProfile(saved && saved[STORAGE_KEY])).catch((error) => {
    console.warn("[GPT AntiCurse diagnostic] Could not read backend request profile", error);
    return emptyProfile();
  });

  function statusKey(event) {
    if (event.outcome === "error") return "error";
    return event.statusCode == null ? "unknown" : String(event.statusCode);
  }

  function groupKey(event) {
    const query = event.queryKeys.length ? `?${event.queryKeys.join(",")}` : "";
    return `tab:${event.tabId} ${event.source} ${event.method} ${event.route}${query} ${event.conversationTarget ? "TARGET" : "PASS"}`;
  }

  function trimGroups(groups) {
    const entries = Object.entries(groups);
    if (entries.length <= MAX_GROUPS) return groups;
    entries.sort((left, right) => Number(right[1] && right[1].lastAt ? Date.parse(right[1].lastAt) : 0) - Number(left[1] && left[1].lastAt ? Date.parse(left[1].lastAt) : 0));
    return Object.fromEntries(entries.slice(0, MAX_GROUPS));
  }

  function applyEvent(profile, event) {
    profile.total = Math.max(0, Number(profile.total) || 0) + 1;
    if (event.outcome === "error") profile.failed = Math.max(0, Number(profile.failed) || 0) + 1;
    else profile.completed = Math.max(0, Number(profile.completed) || 0) + 1;
    if (event.conversationTarget) profile.conversationTargets = Math.max(0, Number(profile.conversationTargets) || 0) + 1;
    else profile.nonConversationTargets = Math.max(0, Number(profile.nonConversationTargets) || 0) + 1;
    profile.sources[event.source] = Math.max(0, Number(profile.sources[event.source]) || 0) + 1;

    const tabKey = String(event.tabId);
    const tab = profile.tabs[tabKey] && typeof profile.tabs[tabKey] === "object" ? profile.tabs[tabKey] : {};
    profile.tabs[tabKey] = {
      total: Math.max(0, Number(tab.total) || 0) + 1,
      conversationTargets: Math.max(0, Number(tab.conversationTargets) || 0) + (event.conversationTarget ? 1 : 0),
      rateLimited: Math.max(0, Number(tab.rateLimited) || 0) + (event.statusCode === 429 ? 1 : 0),
      firstAt: tab.firstAt || event.at,
      lastAt: event.at
    };

    const key = groupKey(event);
    const previous = profile.groups[key] && typeof profile.groups[key] === "object" ? profile.groups[key] : {};
    const statuses = previous.statuses && typeof previous.statuses === "object" ? { ...previous.statuses } : {};
    const status = statusKey(event);
    statuses[status] = Math.max(0, Number(statuses[status]) || 0) + 1;
    const retryAfterValues = Array.isArray(previous.retryAfterSeconds) ? previous.retryAfterSeconds.slice(-7) : [];
    if (Number.isFinite(event.retryAfterSeconds) && !retryAfterValues.includes(event.retryAfterSeconds)) retryAfterValues.push(event.retryAfterSeconds);
    profile.groups[key] = {
      tabId: event.tabId,
      source: event.source,
      method: event.method,
      route: event.route,
      queryKeys: event.queryKeys,
      conversationTarget: event.conversationTarget,
      requestType: event.requestType,
      count: Math.max(0, Number(previous.count) || 0) + 1,
      statuses,
      retryAfterSeconds: retryAfterValues,
      firstAt: previous.firstAt || event.at,
      lastAt: event.at
    };
    profile.groups = trimGroups(profile.groups);
    profile.recent.push(event);
    if (profile.recent.length > MAX_RECENT) profile.recent.splice(0, profile.recent.length - MAX_RECENT);
    profile.updatedAt = event.at;
  }

  async function persistBatch(events) {
    const profile = await profileReady;
    for (const event of events) applyEvent(profile, event);
    await browser.storage.local.set({ [STORAGE_KEY]: profile });
    return profile;
  }

  function flush() {
    if (flushTimer != null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!pendingEvents.length) return writeQueue;
    const events = pendingEvents;
    pendingEvents = [];
    const operation = writeQueue.then(() => persistBatch(events));
    writeQueue = operation.catch((error) => {
      console.warn("[GPT AntiCurse diagnostic] Could not persist backend request metadata", error);
    });
    return operation;
  }

  function scheduleFlush() {
    if (flushTimer != null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush().catch((error) => console.debug("[GPT AntiCurse diagnostic] Deferred request-profile flush failed", error));
    }, FLUSH_DELAY_MS);
  }

  function record(details, outcome) {
    const event = classify(details, outcome);
    if (details && details.requestId) {
      requestSources.delete(details.requestId);
      responseMeta.delete(details.requestId);
    }
    if (!event) return Promise.resolve(false);
    pendingEvents.push(event);
    scheduleFlush();
    return Promise.resolve(true);
  }

  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const headers = Array.isArray(details && details.requestHeaders) ? details.requestHeaders : [];
      const marked = headers.some((header) => String(header && header.name || "").toLowerCase() === EXPORT_HEADER_NAME);
      if (marked && details.requestId) requestSources.set(details.requestId, "anticurse-export");
      return {};
    },
    { urls: ["https://chatgpt.com/backend-api/*"] },
    ["requestHeaders"]
  );

  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (!details || !details.requestId || details.statusCode !== 429) return {};
      const headers = Array.isArray(details.responseHeaders) ? details.responseHeaders : [];
      const retry = headers.find((header) => String(header && header.name || "").toLowerCase() === "retry-after");
      const retryAfterSeconds = normalizedRetryAfter(retry && retry.value);
      if (retryAfterSeconds != null) responseMeta.set(details.requestId, { retryAfterSeconds });
      return {};
    },
    { urls: ["https://chatgpt.com/backend-api/*"] },
    ["responseHeaders"]
  );

  browser.webRequest.onCompleted.addListener(
    (details) => { record(details, "completed"); },
    { urls: ["https://chatgpt.com/backend-api/*"] }
  );

  browser.webRequest.onErrorOccurred.addListener(
    (details) => { record(details, "error"); },
    { urls: ["https://chatgpt.com/backend-api/*"] }
  );

  browser.runtime.onInstalled.addListener(() => {
    if (flushTimer != null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    pendingEvents = [];
    requestSources.clear();
    responseMeta.clear();
    writeQueue = writeQueue.then(async () => {
      const profile = await profileReady;
      Object.assign(profile, emptyProfile());
      await browser.storage.local.remove(STORAGE_KEY);
    }).catch((error) => {
      console.warn("[GPT AntiCurse diagnostic] Could not reset backend request profile", error);
    });
  });

  globalThis.CGAntiCurseBackendRequestProfiler = {
    STORAGE_KEY,
    PROFILE_VERSION,
    routeFromUrl,
    queryKeysFromUrl,
    isConversationTarget,
    normalizedRetryAfter,
    classify,
    record,
    flush
  };
})();
