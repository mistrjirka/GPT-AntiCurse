/* One-reload handoff state for stall recovery. */
(() => {
  "use strict";

  const STORAGE_PREFIX = "cg-anticurse-recovery-reload:";
  const TTL_MS = 10 * 60_000;
  const MAX_RELOADS = 1;
  let writes = 0;
  let clears = 0;
  let rejectedReloads = 0;
  let lastError = null;

  function conversationId() {
    const match = location.pathname.match(/^\/(?:c|branch)\/([^/?#]+)/);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch { return null; }
  }

  function key(id) { return `${STORAGE_PREFIX}${id}`; }
  function terminal(marker) { return !!marker && String(marker.stage || "").startsWith("finished-"); }

  function valid(marker, id) {
    if (!marker || typeof marker !== "object") return false;
    if (marker.version !== 1 || marker.conversationId !== id) return false;
    const at = Number(marker.updatedAt || marker.createdAt || 0);
    return Number.isFinite(at) && at > 0 && Date.now() - at <= TTL_MS;
  }

  function readRaw(id = conversationId()) {
    if (!id) return null;
    try {
      const parsed = JSON.parse(sessionStorage.getItem(key(id)) || "null");
      if (valid(parsed, id)) return parsed;
      if (parsed) sessionStorage.removeItem(key(id));
    } catch (error) {
      lastError = String(error && error.message ? error.message : error);
    }
    return null;
  }

  function read(id = conversationId()) {
    const marker = readRaw(id);
    return marker && !terminal(marker) ? marker : null;
  }

  function pending(id = conversationId()) { return read(id); }

  function write(marker) {
    if (!marker || !marker.conversationId) return false;
    try {
      sessionStorage.setItem(key(marker.conversationId), JSON.stringify(marker));
      writes++;
      return true;
    } catch (error) {
      lastError = String(error && error.message ? error.message : error);
      return false;
    }
  }

  function sameTurn(existingKey, nextKey) {
    if (existingKey && nextKey) return existingKey === nextKey;
    if (!existingKey && nextKey) return false;
    return true;
  }

  function armReload({ conversationId: id = conversationId(), turnKey = null, reason = "unknown", modelSlug = null } = {}) {
    if (!id) return { ok: false, reason: "no-conversation", marker: null };
    const existing = readRaw(id);
    if (existing && Number(existing.reloadCount || 0) >= MAX_RELOADS && sameTurn(existing.turnKey, turnKey)) {
      rejectedReloads++;
      return { ok: false, reason: "reload-already-used", marker: existing };
    }
    const now = Date.now();
    const marker = {
      version: 1,
      conversationId: id,
      turnKey: turnKey || null,
      modelSlug: modelSlug || null,
      reason,
      stage: "reloading",
      reloadCount: 1,
      createdAt: now,
      updatedAt: now
    };
    if (!write(marker)) return { ok: false, reason: "storage-failed", marker: null };
    return { ok: true, reason: null, marker };
  }

  function updateStage(stage, extra = {}) {
    const id = conversationId();
    const marker = readRaw(id);
    if (!marker) return null;
    const next = {
      ...marker,
      ...extra,
      conversationId: id,
      stage: String(stage || marker.stage || "unknown"),
      updatedAt: Date.now()
    };
    return write(next) ? next : null;
  }

  function finish(outcome, extra = {}) {
    return updateStage(`finished-${String(outcome || "unknown")}`, extra);
  }

  function clear(id = conversationId()) {
    if (!id) return false;
    const marker = readRaw(id);
    if (!marker) return false;
    const done = {
      ...marker,
      stage: terminal(marker) ? marker.stage : "finished-cleared",
      updatedAt: Date.now()
    };
    if (!write(done)) return false;
    clears++;
    return true;
  }

  globalThis.CGAntiCurseRecoveryReloadState = {
    read,
    pending,
    armReload,
    updateStage,
    finish,
    clear,
    debug() {
      return {
        present: true,
        conversationId: conversationId(),
        marker: readRaw(),
        pending: pending(),
        ttlSeconds: TTL_MS / 1000,
        maxReloads: MAX_RELOADS,
        writes,
        clears,
        rejectedReloads,
        lastError
      };
    }
  };
})();
