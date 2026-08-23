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

  function key(id) {
    return `${STORAGE_PREFIX}${id}`;
  }

  function valid(marker, id) {
    if (!marker || typeof marker !== "object") return false;
    if (marker.version !== 1 || marker.conversationId !== id) return false;
    const at = Number(marker.updatedAt || marker.createdAt || 0);
    return Number.isFinite(at) && at > 0 && Date.now() - at <= TTL_MS;
  }

  function read(id = conversationId()) {
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

  function armReload({ conversationId: id = conversationId(), turnKey = null, reason = "unknown", modelSlug = null } = {}) {
    if (!id) return { ok: false, reason: "no-conversation", marker: null };
    const existing = read(id);
    if (existing && Number(existing.reloadCount || 0) >= MAX_RELOADS) {
      rejectedReloads++;
      return { ok: false, reason: "reload-already-used", marker: existing };
    }
    const now = Date.now();
    const marker = {
      version: 1,
      conversationId: id,
      turnKey: turnKey || (existing && existing.turnKey) || null,
      modelSlug: modelSlug || (existing && existing.modelSlug) || null,
      reason,
      stage: "reloading",
      reloadCount: Number(existing && existing.reloadCount || 0) + 1,
      createdAt: Number(existing && existing.createdAt || now),
      updatedAt: now
    };
    if (!write(marker)) return { ok: false, reason: "storage-failed", marker: null };
    return { ok: true, reason: null, marker };
  }

  function updateStage(stage, extra = {}) {
    const id = conversationId();
    const marker = read(id);
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

  function clear(id = conversationId()) {
    if (!id) return false;
    try {
      sessionStorage.removeItem(key(id));
      clears++;
      return true;
    } catch (error) {
      lastError = String(error && error.message ? error.message : error);
      return false;
    }
  }

  globalThis.CGAntiCurseRecoveryReloadState = {
    read,
    armReload,
    updateStage,
    clear,
    debug() {
      return {
        present: true,
        conversationId: conversationId(),
        marker: read(),
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
