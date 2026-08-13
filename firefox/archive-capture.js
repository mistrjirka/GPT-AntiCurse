/*
 * Content-side incremental backup capture.
 *
 * The initial authoritative archive comes from the untrimmed conversation GET.
 * This observer only merges visible turns created/updated after that GET, so a
 * long chat remains current even if the page is never reloaded again.
 */
(() => {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const CHANNEL = "__gpt_anticurse_v1__";
  const DEFAULT_SETTINGS = { archiveEnabled: true };
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const ROLE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
  const CAPTURE_TAIL_TURNS = 96;

  let archiveEnabled = true;
  let currentConversationId = null;
  let captureTimer = null;
  let lastFingerprint = "";

  function conversationId() {
    const fromPage = CGArchive.conversationIdFromUrl(location.href);
    if (fromPage) currentConversationId = fromPage;
    return currentConversationId;
  }

  function turnIndex(turn) {
    const testId = turn && turn.getAttribute ? turn.getAttribute("data-testid") : "";
    const match = String(testId || "").match(/^conversation-turn-(\d+)$/);
    return match ? Number(match[1]) : null;
  }

  function visibleText(roleElement) {
    const markdownBlocks = Array.from(roleElement.querySelectorAll(".markdown"));
    if (markdownBlocks.length) {
      const text = markdownBlocks
        .map((node) => node.innerText || node.textContent || "")
        .join("\n\n")
        .trim();
      if (text) return text;
    }
    return (roleElement.innerText || roleElement.textContent || "").trim();
  }

  function collectRenderedMessages() {
    const result = [];
    const turns = Array.from(document.querySelectorAll(TURN_SELECTOR)).slice(-CAPTURE_TAIL_TURNS);

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

    // Fallback if ChatGPT renames the conversation-turn test id but keeps the
    // role attribute used by its message renderer.
    for (const roleElement of Array.from(document.querySelectorAll(ROLE_SELECTOR)).slice(-CAPTURE_TAIL_TURNS)) {
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
    if (!force && nextFingerprint === lastFingerprint) {
      return { ok: true, reason: "unchanged", conversationId: id };
    }
    lastFingerprint = nextFingerprint;

    return ext.runtime.sendMessage({
      type: "cg-merge-rendered-archive",
      conversationId: id,
      title: document.title,
      sourceUrl: location.href,
      messages
    });
  }

  function scheduleCapture(delay = 1200) {
    if (!archiveEnabled || captureTimer) return;
    captureTimer = setTimeout(() => {
      captureTimer = null;
      flushCapture(false).catch(() => {});
    }, delay);
  }

  function touchesConversation(record) {
    const target = record.target && record.target.nodeType === Node.ELEMENT_NODE
      ? record.target
      : record.target && record.target.parentElement;
    if (target && target.closest && target.closest(`${TURN_SELECTOR}, ${ROLE_SELECTOR}`)) return true;

    for (const node of record.addedNodes || []) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.matches?.(`${TURN_SELECTOR}, ${ROLE_SELECTOR}`) || node.querySelector?.(`${TURN_SELECTOR}, ${ROLE_SELECTOR}`)) {
        return true;
      }
    }
    return false;
  }

  function startObserver() {
    if (!document.documentElement) {
      setTimeout(startObserver, 25);
      return;
    }
    const observer = new MutationObserver((records) => {
      if (records.some(touchesConversation)) scheduleCapture();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    scheduleCapture(250);
  }

  // Chromium MAIN-world interception publishes the authoritative untrimmed
  // archive across this private same-page channel. Firefox saves it directly in
  // its background response filter, so it never emits this message.
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.type !== "archive" || !message.archive) return;
    currentConversationId = message.archive.id || currentConversationId;
    ext.runtime.sendMessage({ type: "cg-save-network-archive", archive: message.archive }).catch(() => {});
  });

  ext.storage.local.get(DEFAULT_SETTINGS).then((saved) => {
    archiveEnabled = saved.archiveEnabled !== false;
    if (archiveEnabled) scheduleCapture(100);
  }).catch(() => {});

  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.archiveEnabled) return;
    archiveEnabled = changes.archiveEnabled.newValue !== false;
    if (archiveEnabled) scheduleCapture(50);
  });

  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;
    if (message.type === "cg-get-conversation-id") {
      sendResponse({ conversationId: conversationId() });
      return false;
    }
    if (message.type === "cg-flush-archive") {
      flushCapture(true).then(sendResponse).catch((error) => sendResponse({
        ok: false,
        reason: String(error && error.message ? error.message : error)
      }));
      return true;
    }
    return false;
  });

  window.addEventListener("pagehide", () => {
    if (captureTimer) {
      clearTimeout(captureTimer);
      captureTimer = null;
    }
    flushCapture(true).catch(() => {});
  });

  startObserver();
})();
