/* Reload once when ChatGPT renders a retryable assistant delivery/network error card. */
(() => {
  "use strict";

  const DELIVERY_TIMEOUT_TEXT = "Message delivery timed out. Please try again.";
  const ERROR_CARD_SELECTOR = ".text-token-text-error";
  const RETRY_BUTTON_SELECTOR = 'button[data-testid="regenerate-thread-error-button"]';
  const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
  const STORAGE_PREFIX = "cg-anticurse-delivery-timeout-reload:";
  const RELOAD_COOLDOWN_MS = 60_000;
  const scope = globalThis.CGConversationScope && globalThis.CGConversationScope.create
    ? globalThis.CGConversationScope.create()
    : null;

  let observer = null;
  let detectedCount = 0;
  let reloadCount = 0;
  let suppressedCount = 0;
  let lastDetectedAt = null;
  let lastDetectedMessageId = null;
  let lastAction = null;

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function conversationId() {
    if (scope && typeof scope.currentId === "function") return scope.currentId();
    const match = location.pathname.match(/^\/c\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function latchKey(id) {
    return `${STORAGE_PREFIX}${id}`;
  }

  function readLatch(id) {
    if (!id) return null;
    try {
      const parsed = JSON.parse(sessionStorage.getItem(latchKey(id)) || "null");
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeLatch(id, messageId) {
    try {
      sessionStorage.setItem(latchKey(id), JSON.stringify({ messageId: messageId || null, at: Date.now() }));
    } catch {
      // A storage failure must not turn a one-shot recovery into a reload loop.
      return false;
    }
    return true;
  }


  function isLatestConversationMessage(assistant) {
    const messages = document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]');
    return messages.length > 0 && messages[messages.length - 1] === assistant;
  }

  function retryableHitFromCard(card) {
    if (!(card instanceof Element) || !card.matches(ERROR_CARD_SELECTOR)) return null;
    const assistant = card.closest(ASSISTANT_SELECTOR);
    if (!assistant || !isLatestConversationMessage(assistant)) return null;
    const text = normalize(card.textContent);
    const exactDeliveryTimeout = text === DELIVERY_TIMEOUT_TEXT;
    const nativeRetryButton = !!card.querySelector(RETRY_BUTTON_SELECTOR);
    if (!exactDeliveryTimeout && !nativeRetryButton) return null;
    return {
      reason: exactDeliveryTimeout ? "delivery-timeout" : "retryable-thread-error",
      card,
      assistant,
      messageId: String(assistant.getAttribute("data-message-id") || "").trim() || null
    };
  }

  function timeoutHitFromNode(node) {
    const element = node instanceof Element ? node : node && node.parentElement;
    if (!element) return null;
    const direct = element.matches && element.matches(ERROR_CARD_SELECTOR) ? element : element.closest && element.closest(ERROR_CARD_SELECTOR);
    const directHit = direct && retryableHitFromCard(direct);
    if (directHit) return directHit;
    if (!element.querySelectorAll) return null;
    for (const card of element.querySelectorAll(ERROR_CARD_SELECTOR)) {
      const hit = retryableHitFromCard(card);
      if (hit) return hit;
    }
    return null;
  }

  function shouldReload(id, hit) {
    const latch = readLatch(id);
    if (!latch) return true;
    if (hit.messageId && latch.messageId === hit.messageId) return false;
    // A backend failure can produce a fresh assistant message id after every
    // reload. Rate-limit all reloads per conversation as well as deduplicating
    // the exact message id, so a persistent outage cannot create a reload loop.
    if (Date.now() - Number(latch.at || 0) < RELOAD_COOLDOWN_MS) return false;
    return true;
  }

  function handleHit(hit) {
    if (!hit) return false;
    const id = conversationId();
    if (!id) return false;
    detectedCount++;
    lastDetectedAt = Date.now();
    lastDetectedMessageId = hit.messageId;

    if (!shouldReload(id, hit)) {
      suppressedCount++;
      lastAction = "suppressed-repeat";
      return false;
    }

    // Persist the exact failed assistant-message identity before reloading. If
    // the same server-side error card survives hydration after the reload, the
    // second copy is suppressed and cannot create a reload loop.
    if (!writeLatch(id, hit.messageId)) {
      suppressedCount++;
      lastAction = "suppressed-no-latch";
      return false;
    }

    reloadCount++;
    lastAction = "reload";
    location.reload();
    return true;
  }

  function initialScan() {
    for (const card of document.querySelectorAll(ERROR_CARD_SELECTOR)) {
      const hit = retryableHitFromCard(card);
      if (hit && handleHit(hit)) return true;
    }
    return false;
  }

  function observe() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") {
          const hit = timeoutHitFromNode(record.target);
          if (hit && handleHit(hit)) return;
          continue;
        }
        for (const node of record.addedNodes || []) {
          const hit = timeoutHitFromNode(node);
          if (hit && handleHit(hit)) return;
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  observe();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialScan, { once: true });
  } else {
    initialScan();
  }

  globalThis.CGAntiCurseDeliveryTimeoutReload = {
    debug() {
      const id = conversationId();
      return {
        deliveryTimeoutText: DELIVERY_TIMEOUT_TEXT,
        conversationId: id,
        observerActive: !!observer,
        detectedCount,
        reloadCount,
        suppressedCount,
        lastDetectedAt,
        lastDetectedMessageId,
        lastAction,
        latch: readLatch(id)
      };
    }
  };
})();
