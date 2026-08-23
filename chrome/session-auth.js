/* Transient ChatGPT session-token resolution shared by on-demand extension features. */
(function (global) {
  "use strict";

  const AUTH_FETCH_TIMEOUT_MS = 5_000;
  const RECOVERY_FETCH_TIMEOUT_MS = 5_000;
  const nativeFetch = global.fetch.bind(global);

  function shouldBoundRecoveryFetch(input) {
    try {
      const raw = typeof input === "string" || input instanceof URL
        ? String(input)
        : (input && typeof input.url === "string" ? input.url : "");
      if (!raw) return false;
      const url = new URL(raw, location.origin);
      if (url.origin !== location.origin) return false;
      return url.pathname === "/api/auth/session" ||
        /^\/backend-api\/conversation\/[^/]+\/stream_status$/.test(url.pathname);
    } catch {
      return false;
    }
  }

  function boundedRecoveryFetch(input, init = undefined) {
    if (!shouldBoundRecoveryFetch(input)) return nativeFetch(input, init);
    const controller = new AbortController();
    const upstreamSignal = init?.signal || (input && typeof input === "object" ? input.signal : null);
    let abortListener = null;
    if (upstreamSignal) {
      if (upstreamSignal.aborted) controller.abort(upstreamSignal.reason);
      else {
        abortListener = () => controller.abort(upstreamSignal.reason);
        upstreamSignal.addEventListener("abort", abortListener, { once: true });
      }
    }
    const timeout = setTimeout(() => controller.abort(), RECOVERY_FETCH_TIMEOUT_MS);
    return nativeFetch(input, { ...(init || {}), signal: controller.signal }).finally(() => {
      clearTimeout(timeout);
      if (abortListener) upstreamSignal.removeEventListener("abort", abortListener);
    });
  }

  // All AntiCurse content scripts share this isolated extension world. Install a
  // narrow deadline before the recovery modules load so only ChatGPT auth/session
  // and stream_status requests are bounded; unrelated extension/page fetches are untouched.
  global.fetch = boundedRecoveryFetch;

  function bootstrapAccessToken() {
    const node = document.getElementById("client-bootstrap");
    const text = node && typeof node.textContent === "string" ? node.textContent.trim() : "";
    if (!text) return null;
    try {
      const bootstrap = JSON.parse(text);
      const accessToken = typeof bootstrap?.session?.accessToken === "string"
        ? bootstrap.session.accessToken.trim()
        : "";
      return accessToken || null;
    } catch {
      return null;
    }
  }

  async function fetchSessionAccessToken(isCurrent) {
    if (typeof isCurrent === "function" && !isCurrent()) return { ok: false, reason: "conversation-changed" };
    let response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUTH_FETCH_TIMEOUT_MS);
    try {
      response = await nativeFetch(`${location.origin}/api/auth/session`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: controller.signal
      });
    } catch (error) {
      const timedOut = controller.signal.aborted;
      return {
        ok: false,
        reason: timedOut ? "auth-session-timeout" : "auth-session-network-failed",
        error: String(error && error.message ? error.message : error)
      };
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return { ok: false, reason: "auth-session-http-status", status: response.status };
    try {
      const session = await response.json();
      if (typeof isCurrent === "function" && !isCurrent()) return { ok: false, reason: "conversation-changed" };
      const accessToken = typeof session?.accessToken === "string" ? session.accessToken.trim() : "";
      if (!accessToken) return { ok: false, reason: "auth-session-token-missing" };
      return { ok: true, accessToken, authSource: "auth-session" };
    } catch (error) {
      return { ok: false, reason: "auth-session-json-parse-failed", error: String(error && error.message ? error.message : error) };
    }
  }

  async function resolveAccessToken(options = {}) {
    const isCurrent = typeof options.isCurrent === "function" ? options.isCurrent : null;
    const session = await fetchSessionAccessToken(isCurrent);
    if (session.ok) return session;
    if (isCurrent && !isCurrent()) return { ok: false, reason: "conversation-changed" };
    const accessToken = bootstrapAccessToken();
    if (accessToken) {
      return {
        ok: true,
        accessToken,
        authSource: "client-bootstrap",
        authFallbackReason: session.reason || null
      };
    }
    return session;
  }

  global.CGAntiCurseSessionAuth = Object.freeze({
    bootstrapAccessToken,
    fetchSessionAccessToken,
    resolveAccessToken,
    boundedRecoveryFetch,
    recoveryFetchTimeoutMs: RECOVERY_FETCH_TIMEOUT_MS
  });
})(globalThis);
