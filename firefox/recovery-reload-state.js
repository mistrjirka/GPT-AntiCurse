/* Tab-scoped, short-lived state for one guarded recovery reload. */
(() => {
  "use strict";

  const KEY = "__gpt_anticurse_recovery_reload_v1__";
  const TTL_MS = 10 * 60_000;
  let readCount = 0;
  let writeCount = 0;
  let clearCount = 0;
  let storageFailures = 0;

  function rawRead() {
    try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); }
    catch { storageFailures++; return null; }
  }

  function clear() {
    try { sessionStorage.removeItem(KEY); clearCount++; return true; }
    catch { storageFailures++; return false; }
  }

  function read(expectedConversationId = null) {
    readCount++;
    const value = rawRead();
    if (!value || typeof value !== "object") return null;
    const at = Number(value.createdAt || 0);
    if (!at || Date.now() - at > TTL_MS) { clear(); return null; }
    if (expectedConversationId && value.conversationId !== expectedConversationId) { clear(); return null; }
    return value;
  }

  function save(value) {
    if (!value || typeof value !== "object" || !value.conversationId || value.approval?.decision !== "non-pro") return false;
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ ...value, createdAt: Number(value.createdAt || Date.now()) }));
      writeCount++;
      return true;
    } catch { storageFailures++; return false; }
  }

  function reload() {
    try { location.reload(); return true; }
    catch { storageFailures++; return false; }
  }

  globalThis.CGAntiCurseRecoveryReloadState = Object.freeze({
    read, save, clear, reload,
    debug() { return { present: !!rawRead(), readCount, writeCount, clearCount, storageFailures, ttlSeconds: TTL_MS / 1000 }; }
  });
})();
