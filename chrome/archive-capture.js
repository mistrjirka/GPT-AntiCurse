/*
 * Content-side archive bridge and incremental backup capture.
 *
 * Network interception supplies the authoritative conversation archive. DOM
 * capture only extends that archive with a hydrated tail and is always scoped
 * to one SPA conversation generation.
 */
(() => {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const CHANNEL = "__gpt_anticurse_v1__";
  const NETWORK_ARCHIVE_EVENT = "__gpt_anticurse_archive_ready__";
  const DEFAULT_SETTINGS = { archiveEnabled: true };
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const ROLE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
  const LIVE_CAPTURE_TAIL_TURNS = 8;
  const RECOVERY_CAPTURE_TAIL_TURNS = 96;
  const DOM_GATE = globalThis.CGAntiCurseDomReady;
  const DIAGNOSTICS = globalThis.CGAntiCurseDiagnostics;
  const scope = globalThis.CGConversationScope.create();

  let archiveEnabled = false;
  let archiveSettingsReady = false;
  let pendingNetworkArchive = null;
  let latestNetworkArchive = null;
  let confirmedConversationId = null;
  let captureTimer = null;
  let lastFingerprint = "";
  let observedThread = null;
  let observedScope = null;
  let threadObserver = null;
  let parentObserver = null;
  let shellObserver = null;
  let discoveryObserver = null;
  let discoveryRaf = 0;

  function recordIssue(code, error, extra) {
    if (DIAGNOSTICS && typeof DIAGNOSTICS.record === "function") return DIAGNOSTICS.record("archive", code, error, extra);
    console.warn(`[GPT AntiCurse] archive/${code}`, error, extra || "");
    return Promise.resolve(null);
  }

  function clearArchiveIssue() {
    if (DIAGNOSTICS && typeof DIAGNOSTICS.clear === "function") return DIAGNOSTICS.clear("archive");
    return Promise.resolve(false);
  }

  function cancelCapture() {
    if (captureTimer) clearTimeout(captureTimer);
    captureTimer = null;
  }

  function disconnectThreadObservers() {
    if (threadObserver) threadObserver.disconnect();
    if (parentObserver) parentObserver.disconnect();
    if (shellObserver) shellObserver.disconnect();
    threadObserver = null;
    parentObserver = null;
    shellObserver = null;
    observedThread = null;
    observedScope = null;
  }

  function disconnectDiscoveryObserver() {
    if (discoveryObserver) discoveryObserver.disconnect();
    discoveryObserver = null;
  }

  function resetForConversationChange() {
    if (!scope.sync()) return false;
    cancelCapture();
    disconnectThreadObservers();
    lastFingerprint = "";
    const id = scope.currentId();
    confirmedConversationId = latestNetworkArchive && latestNetworkArchive.id === id ? id : null;
    return true;
  }

  function conversationConfirmed(token) {
    if (!token || !token.id || !scope.isCurrent(token)) return false;
    // Generation zero is the initial document: there cannot be a previous SPA
    // conversation DOM in this content-script lifetime. Later generations wait
    // for an intercepted response/history delivery before observing their DOM.
    return token.generation === 0 || confirmedConversationId === token.id;
  }

  globalThis.CGAntiCurseArchiveBridge = {
    get(id) {
      const requestedId = id || scope.currentId();
      if (!requestedId || !latestNetworkArchive || latestNetworkArchive.id !== requestedId) return null;
      return latestNetworkArchive;
    },
    debug() {
      const id = scope.currentId();
      const currentArchive = latestNetworkArchive && latestNetworkArchive.id === id ? latestNetworkArchive : null;
      return {
        conversationId: id,
        transientArchive: !!currentArchive,
        transientMessages: currentArchive && Array.isArray(currentArchive.messages) ? currentArchive.messages.length : 0,
        archiveEnabled,
        archiveSettingsReady,
        conversationConfirmed: !!id && (scope.snapshot().generation === 0 || confirmedConversationId === id),
        threadObserved: !!(observedThread && observedThread.isConnected),
        discoveryActive: !!discoveryObserver,
        capturePending: !!captureTimer,
        liveCaptureTailTurns: LIVE_CAPTURE_TAIL_TURNS
      };
    }
  };

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

  function confirmConversation(id) {
    resetForConversationChange();
    if (!id || id !== scope.currentId()) return false;
    confirmedConversationId = id;
    if (archiveEnabled && (!DOM_GATE || DOM_GATE.isReady())) {
      scheduleThreadAttachment();
      scheduleCapture(50);
    }
    return true;
  }

  function acceptNetworkArchive(archive) {
    if (!archive || !archive.id || !Array.isArray(archive.messages)) {
      recordIssue("invalid-network-archive", "MAIN world supplied an invalid conversation archive.");
      return false;
    }

    resetForConversationChange();
    const currentId = scope.currentId();
    if (!currentId || archive.id === currentId) {
      latestNetworkArchive = archive;
      confirmConversation(archive.id);
      window.dispatchEvent(new Event(NETWORK_ARCHIVE_EVENT));
    }

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
      const value = markdownBlocks.map((node) => node.textContent || "").join("\n\n").trim();
      if (value) return value;
    }
    return (roleElement.textContent || "").trim();
  }

  function collectRenderedMessages(limit = LIVE_CAPTURE_TAIL_TURNS) {
    const root = observedThread && observedThread.isConnected ? observedThread : document.querySelector("#thread");
    if (!root) return [];

    const result = [];
    const turns = Array.from(root.querySelectorAll(TURN_SELECTOR)).slice(-limit);
    if (turns.length) {
      for (const turn of turns) {
        const roleElement = turn.querySelector(ROLE_SELECTOR);
        if (!roleElement) continue;
        const role = roleElement.getAttribute("data-message-author-role");
        const text = visibleText(roleElement);
        if (text) result.push({ role, text, turnIndex: turnIndex(turn) });
      }
      return result;
    }

    for (const roleElement of Array.from(root.querySelectorAll(ROLE_SELECTOR)).slice(-limit)) {
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
    if (resetForConversationChange()) return { ok: false, reason: "conversation-changed" };

    const token = observedScope || scope.snapshot();
    if (!conversationConfirmed(token)) return { ok: false, reason: "conversation-unconfirmed", conversationId: token.id };

    const sourceUrl = location.href;
    // The intercepted network archive already contains historical records. Live
    // DOM capture only needs the newest rendered tail; a full scan is reserved
    // for DOM-only recovery and explicit/manual final flushes.
    const captureLimit = force || (!latestNetworkArchive && !lastFingerprint)
      ? RECOVERY_CAPTURE_TAIL_TURNS
      : LIVE_CAPTURE_TAIL_TURNS;
    const messages = collectRenderedMessages(captureLimit);
    if (!scope.isCurrent(token)) return { ok: false, reason: "conversation-changed", conversationId: token.id };
    if (!messages.length) return { ok: false, reason: "no-rendered-turns", conversationId: token.id };

    const nextFingerprint = fingerprint(token.id, messages);
    if (!force && nextFingerprint === lastFingerprint) return { ok: true, reason: "unchanged", conversationId: token.id };

    const result = await ext.runtime.sendMessage({
      type: "cg-merge-rendered-archive",
      conversationId: token.id,
      title: document.title,
      sourceUrl,
      messages
    });
    if (!result || result.ok !== true) throw new Error(result && result.reason ? result.reason : "Background did not confirm rendered archive merge.");
    lastFingerprint = nextFingerprint;
    return result;
  }

  function scheduleCapture(delay = 2500) {
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
    disconnectThreadObservers();
    disconnectDiscoveryObserver();
    if (discoveryRaf) cancelAnimationFrame(discoveryRaf);
    discoveryRaf = 0;
  }

  function installDiscoveryObserver() {
    if (discoveryObserver || !archiveEnabled || !document.documentElement || (observedThread && observedThread.isConnected)) return;
    discoveryObserver = new MutationObserver(() => {
      if (resetForConversationChange()) {
        scheduleThreadAttachment();
        return;
      }
      if (!observedThread || !observedThread.isConnected) scheduleThreadAttachment();
    });
    discoveryObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function attachThreadObserver() {
    resetForConversationChange();
    if (!archiveEnabled) return false;
    const token = scope.snapshot();
    if (!conversationConfirmed(token)) return false;

    const thread = document.querySelector("#thread");
    if (!thread || !thread.parentElement) return false;
    if (thread === observedThread && observedScope && scope.isCurrent(observedScope) && threadObserver) {
      disconnectDiscoveryObserver();
      return true;
    }

    disconnectThreadObservers();
    observedThread = thread;
    observedScope = token;
    threadObserver = new MutationObserver((records) => {
      if (!scope.isCurrent(observedScope)) {
        resetForConversationChange();
        installDiscoveryObserver();
        scheduleThreadAttachment();
        return;
      }
      if (records.some(touchesConversation)) scheduleCapture();
    });
    threadObserver.observe(thread, { childList: true, subtree: true, characterData: true });

    const parent = thread.parentElement;
    parentObserver = new MutationObserver(() => {
      const changed = resetForConversationChange() || document.querySelector("#thread") !== observedThread;
      if (!changed) return;
      disconnectThreadObservers();
      installDiscoveryObserver();
      scheduleThreadAttachment();
    });
    parentObserver.observe(parent, { childList: true });

    const shell = parent.parentElement;
    if (shell) {
      shellObserver = new MutationObserver(() => {
        if (parent.isConnected && observedThread && observedThread.isConnected) return;
        disconnectThreadObservers();
        installDiscoveryObserver();
        scheduleThreadAttachment();
      });
      shellObserver.observe(shell, { childList: true });
    }

    disconnectDiscoveryObserver();
    scheduleCapture(250);
    return true;
  }

  function scheduleThreadAttachment() {
    if (!archiveEnabled || discoveryRaf) return;
    discoveryRaf = requestAnimationFrame(() => {
      discoveryRaf = 0;
      if (!attachThreadObserver()) installDiscoveryObserver();
    });
  }

  function startObserver() {
    if (!archiveEnabled) return;
    scheduleThreadAttachment();
    installDiscoveryObserver();
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
    if (archiveEnabled && (!DOM_GATE || DOM_GATE.isReady())) {
      startObserver();
      scheduleCapture(100);
    }
  }).catch((error) => {
    archiveEnabled = false;
    archiveSettingsReady = true;
    pendingNetworkArchive = null;
    disconnectObservers();
    recordIssue("backup-setting-read-failed", error);
  });

  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.archiveEnabled) return;
    archiveEnabled = changes.archiveEnabled.newValue !== false;
    if (archiveEnabled) {
      persistNetworkArchive(latestNetworkArchive);
      if (!DOM_GATE || DOM_GATE.isReady()) {
        startObserver();
        scheduleCapture(50);
      }
    } else {
      cancelCapture();
      disconnectObservers();
    }
  });

  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;
    if (message.type === "cg-conversation-scope" && message.conversationId) {
      confirmConversation(message.conversationId);
      return false;
    }
    if (message.type === "cg-window-history" && message.history && message.history.conversationId) {
      confirmConversation(message.history.conversationId);
      return false;
    }
    if (message.type === "cg-get-conversation-id") {
      sendResponse({ conversationId: scope.currentId() });
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
    cancelCapture();
    flushCapture(true).catch((error) => console.debug("[GPT AntiCurse] Final pagehide backup did not finish", error));
    disconnectObservers();
  });

  if (DOM_GATE) DOM_GATE.whenReady(() => {
    if (archiveEnabled) startObserver();
  });
  else if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", () => {
    if (archiveEnabled) startObserver();
  }, { once: true });
  else if (archiveEnabled) startObserver();
})();
