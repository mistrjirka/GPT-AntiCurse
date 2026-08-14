/* Shared local diagnostics. Never sends telemetry or conversation contents. */
(function (global) {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const STORAGE_KEY = "cgLastIssue";
  const HISTORY_KEY = "cgIssueHistory";
  const MAX_HISTORY = 24;
  let writeQueue = Promise.resolve();

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

  function sameIssue(left, right) {
    return !!left && left.scope === right.scope && left.code === right.code && left.message === right.message;
  }

  async function persistIssue(issue) {
    if (!ext || !ext.storage || !ext.storage.local) return issue;
    const saved = await ext.storage.local.get({ [HISTORY_KEY]: [] });
    const history = Array.isArray(saved[HISTORY_KEY]) ? saved[HISTORY_KEY].slice(-MAX_HISTORY) : [];
    const previous = history[history.length - 1];
    if (sameIssue(previous, issue)) {
      history[history.length - 1] = {
        ...previous,
        at: issue.at,
        count: Math.max(1, Number(previous.count) || 1) + 1,
        ...(issue.extra ? { extra: issue.extra } : {})
      };
    } else {
      history.push({ ...issue, count: 1 });
      if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    }
    await ext.storage.local.set({ [STORAGE_KEY]: issue, [HISTORY_KEY]: history });
    return issue;
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

    const operation = writeQueue.then(() => persistIssue(issue));
    // A failed diagnostic write must not poison every later diagnostic attempt.
    writeQueue = operation.catch((storageError) => {
      console.error("[GPT AntiCurse] Failed to persist local diagnostic", storageError, issue);
    });
    return operation.catch(() => issue);
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

  function history() {
    if (!ext || !ext.storage || !ext.storage.local) return Promise.resolve([]);
    return ext.storage.local.get({ [HISTORY_KEY]: [] }).then((saved) => Array.isArray(saved[HISTORY_KEY]) ? saved[HISTORY_KEY] : []).catch((error) => {
      console.error("[GPT AntiCurse] Failed to read diagnostic history", error);
      return [];
    });
  }

  global.CGAntiCurseDiagnostics = { STORAGE_KEY, HISTORY_KEY, MAX_HISTORY, record, clear, history, errorText };
})(typeof globalThis !== "undefined" ? globalThis : this);
