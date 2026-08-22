/* Transient ChatGPT session-token resolution shared by on-demand extension features. */
(function (global) {
  "use strict";

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
    try {
      response = await fetch(`${location.origin}/api/auth/session`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" }
      });
    } catch (error) {
      return { ok: false, reason: "auth-session-network-failed", error: String(error && error.message ? error.message : error) };
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

  global.CGAntiCurseSessionAuth = Object.freeze({ bootstrapAccessToken, fetchSessionAccessToken, resolveAccessToken });
})(globalThis);
