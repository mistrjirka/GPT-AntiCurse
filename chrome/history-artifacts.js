/* Restore archived ChatGPT sandbox-file links using ChatGPT's own download resolver. */
(function (global) {
  "use strict";

  const SESSION_AUTH = global.CGAntiCurseSessionAuth;
  const LINK_SELECTOR = "a[data-cg-sandbox-path]";
  const MAX_ATTEMPTS = 10;
  const MAX_DURATION_MS = 15_000;
  const INITIAL_DELAY_MS = 500;
  const MAX_DELAY_MS = 4_000;

  function conversationId(pathname) {
    const value = pathname == null
      ? (typeof location !== "undefined" ? location.pathname : "")
      : String(pathname);
    const match = value.match(/^\/(?:c|branch)\/([^/?#]+)/);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch { return null; }
  }

  function normalizeSandboxPath(value) {
    const raw = String(value || "").trim();
    const path = raw.replace(/^sandbox:/i, "");
    return path.startsWith("/mnt/data/") ? path : null;
  }

  function fileName(path) {
    const value = String(path || "");
    const name = value.split("/").filter(Boolean).pop() || "download";
    try { return decodeURIComponent(name); } catch { return name; }
  }

  function requestUrl(origin, id, messageId, sandboxPath) {
    const base = String(origin || "https://chatgpt.com").replace(/\/$/, "");
    const params = new URLSearchParams({ message_id: messageId, sandbox_path: sandboxPath });
    return `${base}/backend-api/conversation/${encodeURIComponent(id)}/interpreter/download?${params}`;
  }

  function retryResponse(data) {
    return String(data && data.status || "").trim().toLowerCase() === "retry";
  }

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  async function resolveDownload({ id, messageId, sandboxPath, signal } = {}) {
    const conversation = String(id || "").trim();
    const message = String(messageId || "").trim();
    const path = normalizeSandboxPath(sandboxPath);
    if (!conversation || !message || !path) return { ok: false, reason: "invalid-artifact-reference" };
    if (!SESSION_AUTH || typeof SESSION_AUTH.resolveAccessToken !== "function") {
      return { ok: false, reason: "session-auth-unavailable" };
    }

    const auth = await SESSION_AUTH.resolveAccessToken({
      isCurrent: () => !signal?.aborted && conversationId() === conversation
    });
    if (!auth.ok) return auth;

    const startedAt = Date.now();
    let delay = INITIAL_DELAY_MS;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted || conversationId() !== conversation) return { ok: false, reason: "conversation-changed" };
      let response;
      try {
        response = await fetch(requestUrl(location.origin, conversation, message, path), {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${auth.accessToken}`
          }
        });
      } catch (error) {
        if (signal?.aborted) return { ok: false, reason: "aborted" };
        return { ok: false, reason: "artifact-network-failed", error: String(error && error.message ? error.message : error) };
      }
      if (!response.ok) return { ok: false, reason: "artifact-http-status", status: response.status };

      let data;
      try { data = await response.json(); }
      catch (error) { return { ok: false, reason: "artifact-json-parse-failed", error: String(error && error.message ? error.message : error) }; }

      const url = typeof data?.download_url === "string" ? data.download_url.trim() : "";
      if (url) return { ok: true, downloadUrl: url, fileName: fileName(path), attempts: attempt };
      if (!retryResponse(data)) return { ok: false, reason: "artifact-download-unavailable", status: data?.status || null };
      if (attempt >= MAX_ATTEMPTS || Date.now() - startedAt >= MAX_DURATION_MS) break;
      await sleep(Math.min(delay, Math.max(0, MAX_DURATION_MS - (Date.now() - startedAt))));
      delay = Math.min(MAX_DELAY_MS, Math.ceil(delay * 1.7));
    }
    return { ok: false, reason: "artifact-retry-timeout" };
  }

  function normalizeFileId(value) {
    const raw = String(value || "").trim();
    const pointer = raw.match(/^(?:sediment|file-service):\/\/(file_[A-Za-z0-9_-]+)$/i);
    if (pointer) return pointer[1];
    return /^file_[A-Za-z0-9_-]+$/i.test(raw) ? raw : null;
  }

  async function resolveFileDownload({ id, fileId, signal } = {}) {
    const conversation = String(id || "").trim();
    const file = normalizeFileId(fileId);
    if (!conversation || !file) return { ok: false, reason: "invalid-file-reference" };
    if (!SESSION_AUTH || typeof SESSION_AUTH.resolveAccessToken !== "function") return { ok: false, reason: "session-auth-unavailable" };
    const auth = await SESSION_AUTH.resolveAccessToken({
      isCurrent: () => !signal?.aborted && conversationId() === conversation
    });
    if (!auth.ok) return auth;

    const encodedFile = encodeURIComponent(file);
    const encodedConversation = encodeURIComponent(conversation);
    const urls = [
      `${location.origin}/backend-api/files/download/${encodedFile}?conversation_id=${encodedConversation}&inline=false`,
      `${location.origin}/backend-api/files/${encodedFile}/download?conversation_id=${encodedConversation}&inline=false`
    ];
    let lastReason = "file-download-unavailable";
    for (const url of urls) {
      if (signal?.aborted || conversationId() !== conversation) return { ok: false, reason: "conversation-changed" };
      try {
        const response = await fetch(url, {
          method: "GET", credentials: "same-origin", cache: "no-store", signal,
          headers: { accept: "application/json", authorization: `Bearer ${auth.accessToken}` }
        });
        if (!response.ok) { lastReason = `file-http-${response.status}`; continue; }
        const data = await response.json();
        const downloadUrl = typeof data?.download_url === "string" ? data.download_url.trim() : "";
        if (!downloadUrl) { lastReason = "file-download-url-missing"; continue; }
        return {
          ok: true,
          downloadUrl,
          fileName: typeof data?.file_name === "string" ? fileName(data.file_name) : "",
          sizeBytes: Number.isFinite(Number(data?.file_size_bytes)) ? Number(data.file_size_bytes) : null
        };
      } catch (error) {
        if (signal?.aborted) return { ok: false, reason: "aborted" };
        lastReason = String(error && error.message ? error.message : error || "file-network-failed");
      }
    }
    return { ok: false, reason: lastReason };
  }

  function humanSize(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function fileKind(item) {
    const mime = String(item?.mimeType || "").toLowerCase();
    if (mime.startsWith("image/")) return "Image";
    if (mime.includes("pdf")) return "PDF";
    const name = String(item?.name || "");
    const extension = name.includes(".") ? name.split(".").pop().toUpperCase() : "";
    return extension && extension.length <= 6 ? extension : "File";
  }

  function sandboxLinkPresent(text) {
    return /\[[^\]\n]+\]\(sandbox:\/mnt\/data\/[^)\n]+\)/i.test(String(text || ""));
  }

  function triggerFileDownload(url, name) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    if (name) anchor.download = name;
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  function renderFileCards(root, attachments, options = {}) {
    if (!root || !Array.isArray(attachments) || !attachments.length) return null;
    // Assistant-generated sandbox files already have the richer message-scoped
    // resolver above; avoid showing a duplicate card for the same response.
    if (sandboxLinkPresent(options.sourceText)) return null;
    const id = String(options.conversationId || conversationId() || "").trim();
    const seen = new Set();
    const wrap = document.createElement("div");
    wrap.className = "cg-history-files";

    for (const raw of attachments) {
      const fileId = normalizeFileId(raw?.fileId || raw?.file_id || raw?.asset_pointer);
      if (!fileId || seen.has(fileId)) continue;
      seen.add(fileId);
      const name = String(raw?.name || "").trim();
      const row = document.createElement("div");
      row.className = "cg-history-file-card";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cg-history-file-open";
      const title = document.createElement("span");
      title.className = "cg-history-file-name";
      title.textContent = name || "Image / attachment";
      const meta = document.createElement("span");
      meta.className = "cg-history-file-meta text-token-text-secondary";
      meta.textContent = [fileKind(raw), humanSize(raw?.sizeBytes)].filter(Boolean).join(" · ");
      button.append(title, meta);
      button.addEventListener("click", async () => {
        if (button.dataset.loading === "1") return;
        button.dataset.loading = "1";
        const previous = meta.textContent;
        meta.textContent = "preparing…";
        const result = await resolveFileDownload({ id, fileId });
        button.dataset.loading = "0";
        if (!button.isConnected) return;
        if (!result.ok) {
          meta.textContent = "unavailable";
          button.title = `Archived file could not be resolved (${result.reason}).`;
          return;
        }
        meta.textContent = previous;
        triggerFileDownload(result.downloadUrl, name || result.fileName);
      });
      row.append(button);
      wrap.append(row);
    }
    if (!wrap.childElementCount) return null;
    root.append(wrap);
    return wrap;
  }

  function setLinkState(anchor, state, title) {
    anchor.dataset.cgArtifactState = state;
    if (title) anchor.title = title;
    if (state === "loading") anchor.setAttribute("aria-busy", "true");
    else anchor.removeAttribute("aria-busy");
  }

  function triggerResolvedDownload(anchor, result) {
    anchor.href = result.downloadUrl;
    anchor.download = result.fileName || "download";
    anchor.dataset.cgArtifactResolved = "true";
    setLinkState(anchor, "ready", "Download archived ChatGPT file");
    anchor.click();
  }

  async function handleClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest(LINK_SELECTOR);
    if (!anchor || anchor.dataset.cgArtifactResolved === "true") return;
    event.preventDefault();
    event.stopPropagation();
    if (anchor.dataset.cgArtifactState === "loading") return;

    const id = conversationId();
    const messageId = String(anchor.dataset.cgMessageId || "").trim();
    const sandboxPath = normalizeSandboxPath(anchor.dataset.cgSandboxPath);
    if (!id || !messageId || !sandboxPath) {
      setLinkState(anchor, "error", "This archived file cannot be resolved because its original message reference is unavailable.");
      return;
    }

    setLinkState(anchor, "loading", "Preparing archived ChatGPT file…");
    const result = await resolveDownload({ id, messageId, sandboxPath });
    if (!anchor.isConnected) return;
    if (result.ok) {
      triggerResolvedDownload(anchor, result);
      return;
    }
    setLinkState(anchor, "error", "This archived file is unavailable right now. Click to retry.");
    anchor.href = "#";
    anchor.removeAttribute("download");
  }

  if (typeof document !== "undefined") document.addEventListener("click", handleClick, true);

  const api = Object.freeze({
    conversationId, normalizeSandboxPath, fileName, requestUrl, retryResponse, resolveDownload,
    normalizeFileId, resolveFileDownload, sandboxLinkPresent, renderFileCards
  });
  global.CGAntiCurseHistoryArtifacts = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
