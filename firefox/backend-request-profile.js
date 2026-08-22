/*
 * Temporary Firefox live-site request profiler.
 *
 * Records only coarse backend route metadata, request methods, status codes,
 * query parameter NAMES, and whether AntiCurse would treat the request as a
 * conversation document. It never reads request/response bodies, headers,
 * query values, or conversation text.
 */
"use strict";

(() => {
  const STORAGE_KEY = "cgBackendRequestProfile";
  const PROFILE_VERSION = 1;
  const MAX_RECENT = 80;
  const MAX_GROUPS = 120;
  const ENDPOINT = globalThis.CGConversationEndpoint;
  const extensionVersion = browser.runtime.getManifest().version;
  let writeQueue = Promise.resolve();

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

  function classify(details, outcome) {
    const route = routeFromUrl(details && details.url);
    if (!route) return null;
    const method = String(details && details.method || "UNKNOWN").toUpperCase().slice(0, 16);
    const statusCode = Number.isInteger(details && details.statusCode) ? details.statusCode : null;
    const error = outcome === "error" && details && details.error
      ? String(details.error).slice(0, 120)
      : null;
    return {
      at: isoNow(),
      method,
      route,
      queryKeys: queryKeysFromUrl(details.url),
      conversationTarget: isConversationTarget(details.url),
      outcome,
      statusCode,
      error,
      requestType: details && details.type ? String(details.type).slice(0, 40) : null
    };
  }

  function emptyProfile() {
    const now = isoNow();
    return {
      profileVersion: PROFILE_VERSION,
      extensionVersion,
      privacy: "metadata-only; no bodies, headers, query values, conversation IDs, or conversation text",
      startedAt: now,
      updatedAt: now,
      total: 0,
      completed: 0,
      failed: 0,
      conversationTargets: 0,
      nonConversationTargets: 0,
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
    return `${event.method} ${event.route}${query} ${event.conversationTarget ? "TARGET" : "PASS"}`;
  }

  function trimGroups(groups) {
    const entries = Object.entries(groups);
    if (entries.length <= MAX_GROUPS) return groups;
    entries.sort((left, right) => Number(right[1] && right[1].lastAt ? Date.parse(right[1].lastAt) : 0) - Number(left[1] && left[1].lastAt ? Date.parse(left[1].lastAt) : 0));
    return Object.fromEntries(entries.slice(0, MAX_GROUPS));
  }

  async function persistEvent(event) {
    const profile = await profileReady;
    profile.total = Math.max(0, Number(profile.total) || 0) + 1;
    if (event.outcome === "error") profile.failed = Math.max(0, Number(profile.failed) || 0) + 1;
    else profile.completed = Math.max(0, Number(profile.completed) || 0) + 1;
    if (event.conversationTarget) profile.conversationTargets = Math.max(0, Number(profile.conversationTargets) || 0) + 1;
    else profile.nonConversationTargets = Math.max(0, Number(profile.nonConversationTargets) || 0) + 1;

    const key = groupKey(event);
    const previous = profile.groups[key] && typeof profile.groups[key] === "object" ? profile.groups[key] : {};
    const statuses = previous.statuses && typeof previous.statuses === "object" ? { ...previous.statuses } : {};
    const status = statusKey(event);
    statuses[status] = Math.max(0, Number(statuses[status]) || 0) + 1;
    profile.groups[key] = {
      method: event.method,
      route: event.route,
      queryKeys: event.queryKeys,
      conversationTarget: event.conversationTarget,
      requestType: event.requestType,
      count: Math.max(0, Number(previous.count) || 0) + 1,
      statuses,
      firstAt: previous.firstAt || event.at,
      lastAt: event.at
    };
    profile.groups = trimGroups(profile.groups);
    profile.recent.push(event);
    if (profile.recent.length > MAX_RECENT) profile.recent.splice(0, profile.recent.length - MAX_RECENT);
    profile.updatedAt = event.at;
    await browser.storage.local.set({ [STORAGE_KEY]: profile });
    return profile;
  }

  function record(details, outcome) {
    const event = classify(details, outcome);
    if (!event) return Promise.resolve(false);
    const operation = writeQueue.then(() => persistEvent(event));
    writeQueue = operation.catch((error) => {
      console.warn("[GPT AntiCurse diagnostic] Could not persist backend request metadata", error);
    });
    return operation.then(() => true).catch(() => false);
  }

  browser.webRequest.onCompleted.addListener(
    (details) => { record(details, "completed"); },
    { urls: ["https://chatgpt.com/backend-api/*"] }
  );

  browser.webRequest.onErrorOccurred.addListener(
    (details) => { record(details, "error"); },
    { urls: ["https://chatgpt.com/backend-api/*"] }
  );

  browser.runtime.onInstalled.addListener(() => {
    writeQueue = writeQueue.then(() => browser.storage.local.remove(STORAGE_KEY)).catch((error) => {
      console.warn("[GPT AntiCurse diagnostic] Could not reset backend request profile", error);
    });
  });

  globalThis.CGAntiCurseBackendRequestProfiler = {
    STORAGE_KEY,
    PROFILE_VERSION,
    routeFromUrl,
    queryKeysFromUrl,
    isConversationTarget,
    classify,
    record,
    flush: () => writeQueue
  };
})();
