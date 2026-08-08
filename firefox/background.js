"use strict";

const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "visible-history",
  maxDisplayMessages: 32
};

let settings = { ...DEFAULT_SETTINGS };
const lastStatsByTab = new Map();

browser.storage.local.get(DEFAULT_SETTINGS).then((saved) => {
  settings = { ...DEFAULT_SETTINGS, ...saved };
}).catch(console.error);

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (changes[key]) settings[key] = changes[key].newValue;
  }
});

function isExactConversationDocument(urlString) {
  try {
    const url = new URL(urlString);
    return /^\/backend-api\/conversation\/[^/]+\/?$/.test(url.pathname);
  } catch (_) {
    return false;
  }
}

function safeSetAction(tabId, text, title) {
  if (tabId < 0) return;
  browser.action.setBadgeText({ tabId, text }).catch(() => {});
  browser.action.setTitle({ tabId, title }).catch(() => {});
}

function publishStats(tabId, stats) {
  if (tabId < 0) return;
  lastStatsByTab.set(tabId, stats);
  const badge = stats.mode === "trimmed"
    ? String(stats.mappingNodesAfter)
    : stats.mode === "error" ? "ERR" : "OK";
  const title = stats.mode === "trimmed"
    ? `GPT AntiCurse: ${stats.mappingNodesBefore} → ${stats.mappingNodesAfter} mapping nodes; ${stats.displayAfter} display candidates kept`
    : stats.mode === "error"
      ? `GPT AntiCurse error: original response passed through (${stats.error})`
      : "GPT AntiCurse: response unchanged";
  safeSetAction(tabId, badge, title);
  browser.tabs.sendMessage(tabId, { type: "cg-stats", stats }).catch(() => {});
}

function writeOriginal(filter, chunks) {
  for (const chunk of chunks) filter.write(chunk);
}

function concatChunks(chunks, totalBytes) {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function interceptConversation(details) {
  if (!settings.enabled || details.method !== "GET" || !isExactConversationDocument(details.url)) {
    return {};
  }

  const filter = browser.webRequest.filterResponseData(details.requestId);
  const chunks = [];
  let totalBytes = 0;

  filter.ondata = (event) => {
    const bytes = new Uint8Array(event.data);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    chunks.push(copy);
    totalBytes += copy.byteLength;
  };

  filter.onstop = () => {
    const started = performance.now();
    try {
      const merged = concatChunks(chunks, totalBytes);
      let text = new TextDecoder("utf-8").decode(merged);
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const parsed = JSON.parse(text);

      const transformed = CGTrim.trimConversation(parsed, {
        mode: settings.mode === "recent" ? "recent" : "visible-history",
        maxDisplayMessages: Math.max(4, Math.min(500, Number(settings.maxDisplayMessages) || 32))
      });

      if (!transformed.changed) {
        writeOriginal(filter, chunks);
        if (transformed.reason !== "unsupported-shape") {
          publishStats(details.tabId, {
            mode: "passthrough",
            reason: transformed.reason,
            originalBytes: totalBytes,
            processingMs: +(performance.now() - started).toFixed(2),
            ...(transformed.stats || {})
          });
        }
      } else {
        const output = new TextEncoder().encode(JSON.stringify(transformed.data));
        filter.write(output);
        publishStats(details.tabId, {
          mode: "trimmed",
          transport: "firefox-stream-filter",
          originalBytes: totalBytes,
          outputBytes: output.byteLength,
          processingMs: +(performance.now() - started).toFixed(2),
          ...transformed.stats
        });
      }
    } catch (error) {
      try { writeOriginal(filter, chunks); } catch (_) {}
      publishStats(details.tabId, {
        mode: "error",
        transport: "firefox-stream-filter",
        error: String(error && error.message ? error.message : error),
        originalBytes: totalBytes,
        processingMs: +(performance.now() - started).toFixed(2)
      });
    } finally {
      try { filter.close(); } catch (_) {}
    }
  };

  filter.onerror = () => {
    publishStats(details.tabId, {
      mode: "error",
      transport: "firefox-stream-filter",
      error: filter.error || "StreamFilter error"
    });
  };

  return {};
}

browser.webRequest.onBeforeRequest.addListener(
  interceptConversation,
  { urls: ["https://chatgpt.com/backend-api/conversation/*"] },
  ["blocking"]
);

browser.runtime.onMessage.addListener((message, sender) => {
  if (message && message.type === "cg-get-stats") {
    const tabId = sender.tab ? sender.tab.id : message.tabId;
    return Promise.resolve(lastStatsByTab.get(tabId) || null);
  }
  if (message && message.type === "cg-settings") {
    const next = {};
    if (typeof message.enabled === "boolean") next.enabled = message.enabled;
    if (message.mode === "visible-history" || message.mode === "recent") next.mode = message.mode;
    if (Number.isFinite(Number(message.maxDisplayMessages))) {
      next.maxDisplayMessages = Math.max(4, Math.min(500, Number(message.maxDisplayMessages)));
    }
    return browser.storage.local.set(next).then(() => {
      settings = { ...settings, ...next };
      return settings;
    });
  }
  return undefined;
});
