/* Shared local diagnostics. Never sends telemetry or conversation contents. */
(function (global) {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const STORAGE_KEY = "cgLastIssue";

  function errorText(error, fallback = "Unknown error") {
    if (error == null) return fallback;
    if (typeof error === "string") return error || fallback;
    if (error && typeof error.message === "string" && error.message) return error.message;
    try { return String(error) || fallback; }
    catch (conversionError) {
      console.debug("[GPT AntiCurse] Could not stringify a diagnostic error", conversionError);
      return fallback;
    }
  }

  function safeExtra(extra) {
    if (!extra || typeof extra !== "object") return undefined;
    const result = {};
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value == null) result[key] = value;
    }
    return Object.keys(result).length ? result : undefined;
  }

  function record(scope, code, error, extra) {
    const sanitizedExtra = safeExtra(extra);
    const issue = {
      at: new Date().toISOString(),
      scope: String(scope || "unknown"),
      code: String(code || "unknown-error"),
      message: errorText(error),
      ...(sanitizedExtra ? { extra: sanitizedExtra } : {})
    };
    console.warn(`[GPT AntiCurse] ${issue.scope}/${issue.code}: ${issue.message}`, issue.extra || "");
    if (!ext || !ext.storage || !ext.storage.local) return Promise.resolve(issue);
    return ext.storage.local.set({ [STORAGE_KEY]: issue }).then(() => issue).catch((storageError) => {
      console.error("[GPT AntiCurse] Failed to persist local diagnostic", storageError, issue);
      return issue;
    });
  }

  function clear(scope, code) {
    if (!ext || !ext.storage || !ext.storage.local) return Promise.resolve(false);
    return ext.storage.local.get({ [STORAGE_KEY]: null }).then((saved) => {
      const current = saved && saved[STORAGE_KEY];
      if (!current) return false;
      if (scope && current.scope !== scope) return false;
      if (code && current.code !== code) return false;
      return ext.storage.local.remove(STORAGE_KEY).then(() => true);
    }).catch((error) => {
      console.error("[GPT AntiCurse] Failed to clear local diagnostic", error);
      return false;
    });
  }

  global.CGAntiCurseDiagnostics = { STORAGE_KEY, record, clear, errorText };
})(typeof globalThis !== "undefined" ? globalThis : this);
