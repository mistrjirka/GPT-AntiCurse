from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, got {count}\n--- needle ---\n{old[:800]}")
    p.write_text(text.replace(old, new, 1))


# Shared endpoint parser: expose the current /conversations/<id>/messages route
# without changing the meaning of top-level conversation-document parsing.
for path in ["firefox/conversation-endpoint.js", "chrome/conversation-endpoint.js"]:
    replace_once(path,
'''  const DOCUMENT_PATH = /^\\/backend-api\\/(conversation|conversations)\\/([^/]+)\\/?$/;
  const RESERVED_SEGMENTS = new Set(["init", "search"]);''',
'''  const DOCUMENT_PATH = /^\\/backend-api\\/(conversation|conversations)\\/([^/]+)\\/?$/;
  const MESSAGES_PATH = /^\\/backend-api\\/conversations\\/([^/]+)\\/messages\\/?$/;
  const RESERVED_SEGMENTS = new Set(["init", "search"]);''')
    replace_once(path,
'''  function conversationId(urlString, baseUrl) {
    return parse(urlString, baseUrl)?.id || null;
  }

  function isConversationDocument(urlString, baseUrl) {
    return !!parse(urlString, baseUrl);
  }

  global.CGConversationEndpoint = Object.freeze({ parse, conversationId, isConversationDocument });''',
'''  function parseMessagesPage(urlString, baseUrl = `${CHATGPT_ORIGIN}/`) {
    try {
      const url = new URL(urlString, baseUrl);
      if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") return null;
      const match = url.pathname.match(MESSAGES_PATH);
      if (!match) return null;
      const id = decodeURIComponent(match[1]).trim();
      if (!id || RESERVED_SEGMENTS.has(id.toLowerCase())) return null;
      return {
        id,
        family: "conversations-messages",
        before: url.searchParams.get("before") || null,
        url: url.href
      };
    } catch (_) {
      return null;
    }
  }

  function conversationId(urlString, baseUrl) {
    return parse(urlString, baseUrl)?.id || null;
  }

  function messagesPageConversationId(urlString, baseUrl) {
    return parseMessagesPage(urlString, baseUrl)?.id || null;
  }

  function isConversationDocument(urlString, baseUrl) {
    return !!parse(urlString, baseUrl);
  }

  function isConversationMessagesPage(urlString, baseUrl) {
    return !!parseMessagesPage(urlString, baseUrl);
  }

  global.CGConversationEndpoint = Object.freeze({
    parse,
    parseMessagesPage,
    conversationId,
    messagesPageConversationId,
    isConversationDocument,
    isConversationMessagesPage
  });''')

for path in ["firefox/pagination-firewall.js", "chrome/pagination-firewall.js"]:
    replace_once(path,
'''      return url.searchParams.has("cursor");''',
'''      if (url.searchParams.has("cursor")) return true;
      return /^\\/backend-api\\/conversations\\/[^/]+\\/messages\\/?$/.test(url.pathname) &&
        url.searchParams.has("before");''')

# Firefox: preserve truthful newest-page metadata, terminate only actual older
# pages, and pass non-2xx/empty responses through before JSON decoding.
path = "firefox/background.js"
replace_once(path,
'''function conversationIdFromEndpoint(urlString) {
  if (!ENDPOINT || typeof ENDPOINT.conversationId !== "function") return null;
  return ENDPOINT.conversationId(urlString);
}

function isConversationDocument(urlString) {
  return !!conversationIdFromEndpoint(urlString);
}''',
'''function conversationIdFromEndpoint(urlString) {
  if (!ENDPOINT) return null;
  const documentId = typeof ENDPOINT.conversationId === "function" ? ENDPOINT.conversationId(urlString) : null;
  if (documentId) return documentId;
  return typeof ENDPOINT.messagesPageConversationId === "function"
    ? ENDPOINT.messagesPageConversationId(urlString)
    : null;
}

function isConversationDocument(urlString) {
  return !!conversationIdFromEndpoint(urlString);
}''')

replace_once(path,
'''  const rawMessagesChanged = keptMessages.length !== parsed.messages.length || !!trimmed.changed;
  const changed = hadOlderPages || rawMessagesChanged;
  const data = changed
    ? {
        ...parsed,
        messages: keptMessages,
        current_node: trimmed.data.current_node || parsed.current_node,
        page_info: {
          ...pageInfo,
          has_previous_page: false,
          start_cursor: null
        }
      }
    : parsed;''',
'''  const rawMessagesChanged = keptMessages.length !== parsed.messages.length || !!trimmed.changed;
  // Preserve ChatGPT's real pagination metadata on the newest page. Hiding the
  // cursor made the native data cache see an internally inconsistent snapshot.
  // The actual older-page response is terminated separately below, so old
  // messages still never accumulate in the React-owned graph.
  const changed = rawMessagesChanged;
  const data = changed
    ? {
        ...parsed,
        messages: keptMessages,
        current_node: trimmed.data.current_node || parsed.current_node
      }
    : parsed;''')

replace_once(path,
'''    paginationFirewall: true,
    paginationCursorSuppressed: hadOlderPages,
    paginatedConversationEnvelope: true,''',
'''    paginationFirewall: true,
    paginationCursorSuppressed: false,
    paginationCursorPreserved: hadOlderPages,
    paginatedConversationEnvelope: true,''')

replace_once(path,
'''  if (paginatedConversationEnvelope(parsed)) {
    return transformPaginatedConversation(parsed, conversationId, mode, limit);
  }''',
'''  if (paginatedConversationEnvelope(parsed)) {
    if (cursorRequest) {
      const pageInfo = parsed.page_info || {};
      return {
        mode,
        transformed: {
          changed: true,
          data: {
            ...parsed,
            messages: [],
            page_info: { ...pageInfo, has_previous_page: false, start_cursor: null }
          },
          reason: "trimmed",
          stats: {
            trimMode: mode,
            mappingNodesBefore: parsed.messages.length,
            mappingNodesAfter: 0,
            discardedNodes: parsed.messages.length,
            displayBefore: paginatedVisibleHistory(parsed).length,
            displayAfter: 0,
            logicalDisplayAfter: 0,
            currentNodePreserved: true,
            paginationFirewall: true,
            paginationOlderPageBlocked: true,
            paginationCursorSuppressed: true,
            paginationBlockedNodes: parsed.messages.length,
            paginatedConversationEnvelope: true,
            paginatedMessages: parsed.messages.length,
            paginatedMessagesAfter: 0
          }
        },
        history: null
      };
    }
    return transformPaginatedConversation(parsed, conversationId, mode, limit);
  }''')

replace_once(path,
'''function confirmExportBypassResponse(details) {
  cleanupExportBypassTokens();
  const state = responseFilterStates.get(details && details.requestId);''',
'''function confirmExportBypassResponse(details) {
  cleanupExportBypassTokens();
  const state = responseFilterStates.get(details && details.requestId);
  if (state) state.statusCode = Number(details && details.statusCode) || 0;''')

replace_once(path,
'''async function processResponse(filter, chunks, totalBytes, details, exportBypass = false) {
  const started = performance.now();
  const endpointConversationId = conversationIdFromEndpoint(details.url);
  try {
    if (exportBypass) {
      writeOriginal(filter, chunks);
      return;
    }
    const initialized = await settingsReady;''',
'''async function processResponse(filter, chunks, totalBytes, details, filterState = null) {
  const started = performance.now();
  const endpointConversationId = conversationIdFromEndpoint(details.url);
  const exportBypass = !!(filterState && filterState.exportBypass);
  const responseStatus = Number(filterState && filterState.statusCode) || 0;
  try {
    if (exportBypass) {
      writeOriginal(filter, chunks);
      return;
    }
    // A 429/error body is not a conversation schema. Preserve native HTTP
    // semantics and never turn it into an unsupported-shape warning.
    if (responseStatus && (responseStatus < 200 || responseStatus >= 300)) {
      writeOriginal(filter, chunks);
      publishStats(details.tabId, statsForRequest(details, {
        mode: "passthrough",
        transport: "firefox-stream-filter",
        reason: "http-status",
        responseStatus,
        originalBytes: totalBytes,
        processingMs: +(performance.now() - started).toFixed(2)
      }, endpointConversationId), details.timeStamp);
      return;
    }
    if (totalBytes <= 0) {
      writeOriginal(filter, chunks);
      publishStats(details.tabId, statsForRequest(details, {
        mode: "passthrough",
        transport: "firefox-stream-filter",
        reason: "empty-body",
        responseStatus,
        originalBytes: 0,
        processingMs: +(performance.now() - started).toFixed(2)
      }, endpointConversationId), details.timeStamp);
      return;
    }
    const initialized = await settingsReady;''')

replace_once(path,
'''  const filterState = { exportBypass: false };''',
'''  const filterState = { exportBypass: false, statusCode: 0 };''')

replace_once(path,
'''    processResponse(filter, chunks, totalBytes, details, filterState.exportBypass).catch((error) => {''',
'''    processResponse(filter, chunks, totalBytes, details, filterState).catch((error) => {''')

# Chromium mirrors the same pagination semantics. Non-2xx pass-through already
# exists there.
path = "chrome/main.js"
replace_once(path,
'''  function isConversationDocument(urlString) {
    return !!(ENDPOINT && typeof ENDPOINT.isConversationDocument === "function" && ENDPOINT.isConversationDocument(urlString, location.href));
  }

  function conversationIdFromEndpoint(urlString) {
    if (!ENDPOINT || typeof ENDPOINT.conversationId !== "function") return null;
    return ENDPOINT.conversationId(urlString, location.href);
  }''',
'''  function isConversationDocument(urlString) {
    return !!(ENDPOINT && typeof ENDPOINT.isConversationDocument === "function" && ENDPOINT.isConversationDocument(urlString, location.href));
  }

  function isConversationMessagesPage(urlString) {
    return !!(ENDPOINT && typeof ENDPOINT.isConversationMessagesPage === "function" && ENDPOINT.isConversationMessagesPage(urlString, location.href));
  }

  function conversationIdFromEndpoint(urlString) {
    if (!ENDPOINT) return null;
    const documentId = typeof ENDPOINT.conversationId === "function" ? ENDPOINT.conversationId(urlString, location.href) : null;
    if (documentId) return documentId;
    return typeof ENDPOINT.messagesPageConversationId === "function"
      ? ENDPOINT.messagesPageConversationId(urlString, location.href)
      : null;
  }''')

replace_once(path,
'''    const rawMessagesChanged = keptMessages.length !== data.messages.length || !!trimmed.changed;
    const changed = hadOlderPages || rawMessagesChanged;
    const transformedData = changed
      ? {
          ...data,
          messages: keptMessages,
          current_node: trimmed.data.current_node || data.current_node,
          page_info: { ...pageInfo, has_previous_page: false, start_cursor: null }
        }
      : data;''',
'''    const rawMessagesChanged = keptMessages.length !== data.messages.length || !!trimmed.changed;
    const changed = rawMessagesChanged;
    const transformedData = changed
      ? {
          ...data,
          messages: keptMessages,
          current_node: trimmed.data.current_node || data.current_node
        }
      : data;''')

replace_once(path,
'''        paginationFirewall: true,
        paginationCursorSuppressed: hadOlderPages,
        paginatedConversationEnvelope: true,''',
'''        paginationFirewall: true,
        paginationCursorSuppressed: false,
        paginationCursorPreserved: hadOlderPages,
        paginatedConversationEnvelope: true,''')

replace_once(path,
'''    if (paginatedConversationEnvelope(data)) {
      const transformed = transformPaginatedConversation(
        data,
        trace.conversationId || conversationIdFromEndpoint(trace.endpointUrl || ""),
        resolveMode(settings.mode),
        normalizeMessageLimit(settings.maxDisplayMessages)
      );
      publishTransformStats(transformed, originalBytes, started, trace);
      return transformed.changed ? transformed.data : data;
    }''',
'''    if (paginatedConversationEnvelope(data)) {
      if (cursorRequest) {
        const transformed = {
          changed: true,
          data: {
            ...data,
            messages: [],
            page_info: { ...(data.page_info || {}), has_previous_page: false, start_cursor: null }
          },
          reason: "trimmed",
          stats: {
            trimMode: resolveMode(settings.mode),
            mappingNodesBefore: data.messages.length,
            mappingNodesAfter: 0,
            discardedNodes: data.messages.length,
            displayBefore: paginatedVisibleHistory(data).length,
            displayAfter: 0,
            logicalDisplayAfter: 0,
            currentNodePreserved: true,
            paginationFirewall: true,
            paginationOlderPageBlocked: true,
            paginationCursorSuppressed: true,
            paginationBlockedNodes: data.messages.length,
            paginatedConversationEnvelope: true,
            paginatedMessages: data.messages.length,
            paginatedMessagesAfter: 0
          }
        };
        publishTransformStats(transformed, originalBytes, started, trace);
        return transformed.data;
      }
      const transformed = transformPaginatedConversation(
        data,
        trace.conversationId || conversationIdFromEndpoint(trace.endpointUrl || ""),
        resolveMode(settings.mode),
        normalizeMessageLimit(settings.maxDisplayMessages)
      );
      publishTransformStats(transformed, originalBytes, started, trace);
      return transformed.changed ? transformed.data : data;
    }''')

replace_once(path,
'''    if (!isConversationDocument(response.url)) return readBody();''',
'''    if (!isConversationDocument(response.url) && !isConversationMessagesPage(response.url)) return readBody();''')

# Tests for the current API route and new invariant.
path = "tests/test-conversation-endpoints.js"
replace_once(path,
'''assert.equal(endpoint.parse("/backend-api/conversations/current-id/?cursor=older", "https://chatgpt.com/c/current-id").id, "current-id");''',
'''assert.equal(endpoint.parse("/backend-api/conversations/current-id/?cursor=older", "https://chatgpt.com/c/current-id").id, "current-id");
assert.equal(endpoint.messagesPageConversationId("/backend-api/conversations/current-id/messages?before=older", "https://chatgpt.com/c/current-id"), "current-id");
assert.equal(endpoint.parseMessagesPage("/backend-api/conversations/current-id/messages?before=older", "https://chatgpt.com/c/current-id").before, "older");
assert.equal(endpoint.isConversationDocument("/backend-api/conversations/current-id/messages?before=older", "https://chatgpt.com/c/current-id"), false);
assert.equal(endpoint.isConversationMessagesPage("/backend-api/conversations/current-id/messages?before=older", "https://chatgpt.com/c/current-id"), true);''')

path = "tests/test-pagination-firewall.js"
replace_once(path,
'''assert.equal(firewall.isCursorRequest("https://chatgpt.com/backend-api/conversations/x?foo=cursor"), false);
assert.equal(firewall.isCursorRequest("not a valid url but cursor-like"), false);''',
'''assert.equal(firewall.isCursorRequest("https://chatgpt.com/backend-api/conversations/x?foo=cursor"), false);
assert.equal(firewall.isCursorRequest("https://chatgpt.com/backend-api/conversations/x/messages?include_has_versions=true&num_turns=10&before=abc"), true);
assert.equal(firewall.isCursorRequest("https://chatgpt.com/backend-api/conversations/x/messages?include_has_versions=true&num_turns=10"), false);
assert.equal(firewall.isCursorRequest("not a valid url but cursor-like"), false);''')

path = "tests/e2e-chromium.js"
replace_once(path,
'''    // Current ChatGPT follows before-pages only when page_info still advertises
    // older history. AntiCurse must suppress that before page code sees it.''',
'''    // Preserve truthful pagination metadata on the newest page. AntiCurse
    // terminates the actual older-page response instead.''')
replace_once(path,
'''  assert.equal(state.cursor, null, "pagination firewall must terminate OpenAI's cursor before page/React code receives the newest page");
  assert.equal(state.nativePaginationRequests, 0, "ChatGPT must not request raw older cursor pages after the firewall");''',
'''  assert.equal(state.cursor, "older-page", "newest page must preserve ChatGPT's real pagination cursor");
  assert.equal(state.nativePaginationRequests, 1, "native pagination may request one older page, which AntiCurse terminates before its records enter React");''')

path = "tests/e2e-firefox.js"
replace_once(path,
'''    assert.equal(state.cursor, null, "Firefox pagination firewall must terminate the native cursor before page code sees it");
    assert.equal(state.nativePaginationRequests, 0, "Firefox page code must not fetch raw older cursor pages");''',
'''    assert.equal(state.cursor, "older-firefox-page", "Firefox newest page must preserve ChatGPT's real pagination cursor");
    assert.equal(state.nativePaginationRequests, 1, "Firefox native pagination may request one older page, which AntiCurse terminates before its records enter React");''')

path = ".github/workflows/release.yml"
text = Path(path).read_text()
needle = "            tests/test-firefox-history-source-priority.js\n"
addition = needle + "            tests/test-firefox-conversation-rate-limit-guard.js\n"
if "tests/test-firefox-conversation-rate-limit-guard.js" not in text:
    if text.count(needle) != 1:
        raise SystemExit("release workflow: could not place rate-limit guard test")
    Path(path).write_text(text.replace(needle, addition, 1))
