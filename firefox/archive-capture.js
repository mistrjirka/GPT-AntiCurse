/*
 * Content-side archive bridge and incremental backup capture.
 *
 * Chromium publishes one authoritative untrimmed visible archive from MAIN world.
 * The isolated world keeps that object in memory for current-page history. Only
 * the optional backup copy is persisted to extension IndexedDB. DOM capture is
 * a hydrated tail updater and never observes the whole ChatGPT document.
 */
(() => {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const CHANNEL = "__gpt_anticurse_v1__";
  const NETWORK_ARCHIVE_EVENT = "__gpt_anticurse_archive_ready__";
  const DEFAULT_SETTINGS = { archiveEnabled: true };
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const ROLE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
  const CAPTURE_TAIL_TURNS = 96;
  const DOM_GATE = globalThis.CGAntiCurseDomReady;
  const DIAGNOSTICS = globalThis.CGAntiCurseDiagnostics;

  // Persist nothing until storage explicitly confirms the user's backup setting.
  let archiveEnabled = false;
  let archiveSettingsReady = false;
  let pendingNetworkArchive = null;
  let latestNetworkArchive = null;
  let currentConversationId = null;
  let captureTimer = null;
  let lastFingerprint = "";
  let observedThread = null;
  let threadObserver = null;
  let parentObserver = null;

  function recordIssue(code, error, extra) {
    if (DIAGNOSTICS && typeof DIAGNOSTICS.record === "function") return DIAGNOSTICS.record("archive", code, error, extra);
    console.warn(`[GPT AntiCurse] archive/${code}`, error, extra || "");
    return Promise.resolve(null);
  }

  function clearArchiveIssue() {
    if (DIAGNOSTICS && typeof DIAGNOSTICS.clear === "function") return DIAGNOSTICS.clear("archive");
    return Promise.resolve(false);
  }

  globalThis.CGAntiCurseArchiveBridge = {
    get(id) {
      if (!latestNetworkArchive) return null;
      if (id && latestNetworkArchive.id !== id) return null;
      return latestNetworkArchive;
    }
  };

  function conversationIdFromPage() {
    const match = String(location.pathname || "").match(/(?:^|\/)c\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  function conversationId() {
    const fromPage = conversationIdFromPage();
    if (fromPage) currentConversationId = fromPage;
    return currentConversationId;
  }

  async function persistNetworkArchive(archive) {
    if (!archiveEnabled || !archive) return { ok: false, reason: "backup-disabled" };
    try {
      const result = await ext.runtime.sendMessage({ type: "cg-save-network-archive", archive });
      if (!result || result.ok !== true) {
        await recordIssue("network-persist-rejected", result && result.reason ? result.reason : "Background did not confirm archive persistence.");
        return result || { ok: false, reason: "no-background-response" };
      }
      clearArchiveIssue();
      return result;
    } catch (error) {
      await recordIssue("network-persist-failed", error);
      return { ok: false, reason: "network-persist-failed" };
    }
  }

  function acceptNetworkArchive(archive) {
    if (!archive || !archive.id || !Array.isArray(archive.messages)) {
      recordIssue("invalid-network-archive", "MAIN world supplied an invalid conversation archive.");
      return false;
    }

    currentConversationId = archive.id;
    latestNetworkArchive = archive;
    window.dispatchEvent(new Event(NETWORK_ARCHIVE_EVENT));

    if (!archiveSettingsReady) {
      pendingNetworkArchive = archive;
      return true;
    }
    if (archiveEnabled) persistNetworkArchive(archive);
    return true;
  }

  function turnIndex(turn) {
    const testId = turn && turn.getAttribute ? turn.getAttribute("data-testid") : "";
    const match = String(testId || "").match(/^conversation-turn-(\d+)$/);
    return match ? Number(match[1]) : null;
  }

  function visibleText(roleElement) {
    const markdownBlocks = Array.from(roleElement.querySelectorAll(".markdown"));
    if (markdownBlocks.length) {
      const value = markdownBlocks
        .map((node) => node.innerText || node.textContent || "")
        .join("\n\n")
        .trim();
      if (value) return value;
    }
    return (roleElement.innerText || roleElement.textContent || "").trim();
  }

  function collectRenderedMessages() {
    const root = observedThread && observedThread.isConnected ? observedThread : document.querySelector("#thread");
    if (!root) return [];

    const result = [];
    const turns = Array.from(root.querySelectorAll(TURN_SELECTOR)).slice(-CAPTURE_TAIL_TURNS);
    if (turns.length) {
      for (const turn of turns) {
        const roleElement = turn.querySelector(ROLE_SELECTOR);
        if (!roleElement) continue;
        const role = roleElement.getAttribute("data-message-author-role");
        const text = visibleText(roleElement);
        if (!text) continue;
        result.push({ role, text, turnIndex: turnIndex(turn) });
      }
      return result;
    }

    for (const roleElement of Array.from(root.querySelectorAll(ROLE_SELECTOR)).slice(-CAPTURE_TAIL_TURNS)) {
      const role = roleElement.getAttribute("data-message-author-role");
      const text = visibleText(roleElement);
      if (text) result.push({ role, text, turnIndex: null });
    }
    return result;
  }

  function fingerprint(id, messages) {
    let hash = 2166136261;
    const update = (text) => {
      for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    };

    update(id || "");
    for (const message of messages) {
      update(message.role);
      update(String(message.turnIndex));
      update(message.text);
    }
    return `${messages.length}:${hash >>> 0}`;
  }

  async function flushCapture(force = false) {
    if (!archiveEnabled) return { ok: false, reason: "backup-disabled" };
    const id = conversationId();
    if (!id) return { ok: false, reason: "not-a-conversation" };

    const messages = collectRenderedMessages();
    if (!messages.length) return { ok: false, reason: "no-rendered-turns", conversationId: id };

    const nextFingerprint = fingerprint(id, messages);
    if (!force && nextFingerprint === lastFingerprint) return { ok: true, reason: "unchanged", conversationId: id };
    lastFingerprint = nextFingerprint;

    const result = await ext.runtime.sendMessage({
      type: "cg-merge-rendered-archive",
      conversationId: id,
      title: document.title,
      sourceUrl: location.href,
      messages
    });
    if (!result || result.ok !== true) throw new Error(result && result.reason ? result.reason : "Background did not confirm rendered archive merge.");
    return result;
  }

  function scheduleCapture(delay = 1200) {
    if (!archiveEnabled || captureTimer) return;
    captureTimer = setTimeout(() => {
      captureTimer = null;
      flushCapture(false).then(() => clearArchiveIssue()).catch((error) => recordIssue("tail-merge-failed", error));
    }, delay);
  }

  function touchesConversation(record) {
    const target = record.target && record.target.nodeType === Node.ELEMENT_NODE
      ? record.target
      : record.target && record.target.parentElement;
    if (target && target.closest && target.closest(`${TURN_SELECTOR}, ${ROLE_SELECTOR}`)) return true;

    for (const node of record.addedNodes || []) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.matches?.(`${TURN_SELECTOR}, ${ROLE_SELECTOR}`) || node.querySelector?.(`${TURN_SELECTOR}, ${ROLE_SELECTOR}`)) return true;
    }
    return false;
  }

  function disconnectObservers() {
    if (threadObserver) threadObserver.disconnect();
    if (parentObserver) parentObserver.disconnect();
    threadObserver = null;
    parentObserver = null;
    observedThread = null;
  }

  function attachThreadObserver() {
    const thread = document.querySelector("#thread");
    if (!thread || !thread.parentElement) return false;
    if (thread === observedThread && threadObserver) return true;

    disconnectObservers();
    observedThread = thread;
    threadObserver = new MutationObserver((records) => {
      if (records.some(touchesConversation)) scheduleCapture();
    });
    threadObserver.observe(thread, { childList: true, subtree: true, characterData: true });

    const parent = thread.parentElement;
    parentObserver = new MutationObserver(() => {
      const current = document.querySelector("#thread");
      if (current !== observedThread) {
        attachThreadObserver();
        scheduleCapture(100);
      }
    });
    parentObserver.observe(parent, { childList: true });
    scheduleCapture(250);
    return true;
  }

  function startObserver() {
    if (!attachThreadObserver()) setTimeout(startObserver, 100);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.type !== "archive") return;
    acceptNetworkArchive(message.archive);
  });

  ext.storage.local.get(DEFAULT_SETTINGS).then((saved) => {
    archiveEnabled = saved.archiveEnabled !== false;
    archiveSettingsReady = true;
    if (pendingNetworkArchive) {
      const archive = pendingNetworkArchive;
      pendingNetworkArchive = null;
      if (archiveEnabled) persistNetworkArchive(archive);
    }
    if (archiveEnabled && DOM_GATE && DOM_GATE.isReady()) scheduleCapture(100);
  }).catch((error) => {
    // Fail private: current-page history still uses the transient archive, but
    // persistent backup remains disabled until storage can be read successfully.
    archiveEnabled = false;
    archiveSettingsReady = true;
    pendingNetworkArchive = null;
    recordIssue("backup-setting-read-failed", error);
  });

  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.archiveEnabled) return;
    archiveEnabled = changes.archiveEnabled.newValue !== false;
    if (archiveEnabled) {
      persistNetworkArchive(latestNetworkArchive);
      if (!DOM_GATE || DOM_GATE.isReady()) scheduleCapture(50);
    }
  });

  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;
    if (message.type === "cg-get-conversation-id") {
      sendResponse({ conversationId: conversationId() });
      return false;
    }
    if (message.type === "cg-flush-archive") {
      flushCapture(true).then(sendResponse).catch((error) => {
        recordIssue("manual-flush-failed", error);
        sendResponse({ ok: false, reason: String(error && error.message ? error.message : error) });
      });
      return true;
    }
    return false;
  });

  window.addEventListener("pagehide", () => {
    if (captureTimer) {
      clearTimeout(captureTimer);
      captureTimer = null;
    }
    // Best effort only: page teardown may prevent an async extension message from completing.
    flushCapture(true).catch((error) => console.debug("[GPT AntiCurse] Final pagehide backup did not finish", error));
    disconnectObservers();
  });

  if (DOM_GATE) DOM_GATE.whenReady(startObserver);
  else if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", startObserver, { once: true });
  else startObserver();
})();
