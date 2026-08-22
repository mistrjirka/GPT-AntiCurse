from pathlib import Path
import json


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count == 0 and new in text:
        return
    if count != 1:
        raise SystemExit(f"{path}: expected one match, got {count}\n--- old ---\n{old[:500]}")
    p.write_text(text.replace(old, new, 1))


# Firefox background: load and use native pagination accumulator.
manifest_path = Path("firefox/manifest.json")
manifest = json.loads(manifest_path.read_text())
scripts = manifest["background"]["scripts"]
if "paginated-history-accumulator.js" not in scripts:
    scripts.insert(scripts.index("background.js"), "paginated-history-accumulator.js")
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

replace_once(
    "firefox/background.js",
    'const PAGINATION = globalThis.CGPaginationFirewall;\nconst ENDPOINT = globalThis.CGConversationEndpoint;',
    'const PAGINATION = globalThis.CGPaginationFirewall;\nconst ENDPOINT = globalThis.CGConversationEndpoint;\nconst PAGINATED_HISTORY = globalThis.CGPaginatedHistoryAccumulator\n  ? globalThis.CGPaginatedHistoryAccumulator.create({ maxPages: 100 })\n  : null;'
)

replace_once(
    "firefox/background.js",
    'function transformConversation(parsed, conversationId, cursorRequest = false) {',
    'function transformConversation(parsed, conversationId, cursorRequest = false, continueNativePagination = false) {'
)

replace_once(
    "firefox/background.js",
'''          data: {
            ...parsed,
            messages: [],
            page_info: { ...pageInfo, has_previous_page: false, start_cursor: null }
          },''',
'''          data: {
            ...parsed,
            messages: [],
            page_info: continueNativePagination
              ? pageInfo
              : { ...pageInfo, has_previous_page: false, start_cursor: null }
          },'''
)

replace_once(
    "firefox/background.js",
'''            paginationOlderPageBlocked: true,
            paginationCursorSuppressed: true,
            paginationBlockedNodes: parsed.messages.length,''',
'''            paginationOlderPageBlocked: true,
            paginationCursorSuppressed: !continueNativePagination,
            paginationCursorPreserved: continueNativePagination,
            paginationBlockedNodes: parsed.messages.length,'''
)

replace_once(
    "firefox/background.js",
'''    const cursorRequest = !!(PAGINATION && typeof PAGINATION.isCursorRequest === "function" && PAGINATION.isCursorRequest(details.url));
    const result = transformConversation(parsed, conversationId, cursorRequest);
    publishHistory(details.tabId, result.history, details.timeStamp);''',
'''    const cursorRequest = !!(PAGINATION && typeof PAGINATION.isCursorRequest === "function" && PAGINATION.isCursorRequest(details.url));
    const isPaginated = paginatedConversationEnvelope(parsed);
    let historyObservation = null;
    let continueNativePagination = false;
    let result;

    if (isPaginated && PAGINATED_HISTORY) {
      if (cursorRequest) {
        const requestPage = ENDPOINT && typeof ENDPOINT.parseMessagesPage === "function"
          ? ENDPOINT.parseMessagesPage(details.url)
          : null;
        historyObservation = PAGINATED_HISTORY.observe({
          tabId: details.tabId,
          conversationId,
          cursorRequest: true,
          requestCursor: requestPage && requestPage.before,
          nextCursor: paginatedCursor(parsed),
          messages: paginatedVisibleHistory(parsed),
          pageSize: normalizeMessageLimit(settings.maxDisplayMessages),
          nativeVisibleCount: 0
        });
        continueNativePagination = historyObservation.continueNativePagination === true;
        result = transformConversation(parsed, conversationId, true, continueNativePagination);
      } else {
        result = transformConversation(parsed, conversationId, false, false);
        historyObservation = PAGINATED_HISTORY.observe({
          tabId: details.tabId,
          conversationId,
          cursorRequest: false,
          requestCursor: null,
          nextCursor: paginatedCursor(parsed),
          messages: paginatedVisibleHistory(parsed),
          pageSize: normalizeMessageLimit(settings.maxDisplayMessages),
          nativeVisibleCount: Math.max(0, Number(result.transformed?.stats?.displayAfter) || 0)
        });
      }
      if (historyObservation && historyObservation.history) result.history = historyObservation.history;
    } else {
      result = transformConversation(parsed, conversationId, cursorRequest, false);
    }

    // An incomplete native pagination chain is not "no history". Publish each
    // accumulated partial snapshot, and never delete an existing archive merely
    // because one intermediate response has not reached the oldest page yet.
    if (result.history) publishHistory(details.tabId, result.history, details.timeStamp);
    else if (!isPaginated && !cursorRequest) publishHistory(details.tabId, null, details.timeStamp);'''
)

replace_once(
    "firefox/background.js",
'''      invalidExportBypassMarkers
    });''',
'''      invalidExportBypassMarkers,
      paginatedHistory: PAGINATED_HISTORY && typeof PAGINATED_HISTORY.debug === "function" ? PAGINATED_HISTORY.debug() : null,
      rateLimitGuard: globalThis.CGAntiCurseConversationRateLimitGuard && typeof globalThis.CGAntiCurseConversationRateLimitGuard.debug === "function"
        ? globalThis.CGAntiCurseConversationRateLimitGuard.debug()
        : null
    });'''
)

replace_once(
    "firefox/background.js",
'''  historyByTab.delete(tabId);
  sessionWriteQueues.delete(sessionKey(STATS_KEY_PREFIX, tabId));''',
'''  historyByTab.delete(tabId);
  if (PAGINATED_HISTORY) PAGINATED_HISTORY.clear(tabId);
  sessionWriteQueues.delete(sessionKey(STATS_KEY_PREFIX, tabId));'''
)

# Partial captured history is excellent for the scrolling UI but must not be
# mistaken for a complete authoritative export.
replace_once(
    "firefox/history-source-priority.js",
    '    if (!history || history.ok === false || !Array.isArray(history.messages)) return null;',
    '    if (!history || history.ok === false || history.complete === false || !Array.isArray(history.messages)) return null;'
)

# Firefox automatic windowed history must never trigger an authenticated full
# conversation fallback. Explicit export keeps that path.
replace_once(
    "firefox/windowed.js",
'''      const authoritative = await authoritativeHistory(token);
      if (!scope.isCurrent(token)) return false;
      if (authoritative) return applyHistory(authoritative, token);

      const value = await ext.runtime.sendMessage({''',
'''      if (!IS_FIREFOX) {
        const authoritative = await authoritativeHistory(token);
        if (!scope.isCurrent(token)) return false;
        if (authoritative) return applyHistory(authoritative, token);
      }

      const value = await ext.runtime.sendMessage({'''
)

# Shared 429 guard also covers the paginated /messages family.
replace_once(
    "firefox/conversation-rate-limit-guard.js",
'''    const id = ENDPOINT.conversationId(details.url);
    return id ? `${details.tabId}:${id}` : null;''',
'''    const id = ENDPOINT.conversationId(details.url) ||
      (typeof ENDPOINT.messagesPageConversationId === "function" ? ENDPOINT.messagesPageConversationId(details.url) : null);
    return id ? `${details.tabId}:${id}` : null;'''
)

# Expose the Pro decision directly in normal debug exports.
replace_once(
    "firefox/debug-state.js",
'''      stallRecovery: (() => {
        const recovery = globalThis.CGAntiCurseStallRecovery;
        try { return recovery && typeof recovery.debug === "function" ? { present: true, ...recovery.debug() } : { present: !!recovery }; }
        catch (error) { return { present: !!recovery, debugError: String(error && error.message ? error.message : error) }; }
      })(),
      archiveBridge: bridgeState,''',
'''      proRecoveryGuard: (() => {
        const guard = globalThis.CGAntiCurseProRecoveryGuard;
        try { return guard && typeof guard.debug === "function" ? { present: true, ...guard.debug() } : { present: !!guard }; }
        catch (error) { return { present: !!guard, debugError: String(error && error.message ? error.message : error) }; }
      })(),
      stallRecovery: (() => {
        const recovery = globalThis.CGAntiCurseStallRecovery;
        try { return recovery && typeof recovery.debug === "function" ? { present: true, ...recovery.debug() } : { present: !!recovery }; }
        catch (error) { return { present: !!recovery, debugError: String(error && error.message ? error.message : error) }; }
      })(),
      archiveBridge: bridgeState,'''
)

# Recovery: do not arm ordinary inactivity recovery until actual assistant output
# exists. A pure streaming/progress row is normal loading; explicit long-wait UI
# remains an immediate independent stall signal.
for path in ["firefox/stall-recovery.js", "chrome/stall-recovery.js"]:
    replace_once(
        path,
'''  function recoveryRemainingMs() {
    if (!activeTurn || !stopButton()) return null;
    if (hasLongWaitBanner(activeTurn)) return 0;
    return Math.max(0, thresholdMs() - (Date.now() - lastActivityAt));
  }''',
'''  function recoveryRemainingMs() {
    if (!activeTurn || !stopButton()) return null;
    if (hasLongWaitBanner(activeTurn)) return 0;
    if (preOutputLoading(activeTurn)) return null;
    return Math.max(0, thresholdMs() - (Date.now() - lastActivityAt));
  }'''
    )

    replace_once(
        path,
'''    const longWaitBanner = hasLongWaitBanner(activeTurn);
    const tool = runningTool(activeTurn);
    const draftBlocked = hasUserDraft();
    const hidden = document.visibilityState !== "visible";
    const remainingMs = recoveryRemainingMs();
    const phase = recoveryPhase ||
      (hidden ? "paused-hidden" : draftBlocked ? "paused-draft" : longWaitBanner ? "checking" : "countdown");''',
'''    const longWaitBanner = hasLongWaitBanner(activeTurn);
    const loading = preOutputLoading(activeTurn);
    const tool = runningTool(activeTurn);
    const draftBlocked = hasUserDraft();
    const hidden = document.visibilityState !== "visible";
    const remainingMs = recoveryRemainingMs();
    const phase = recoveryPhase ||
      (hidden ? "paused-hidden" : draftBlocked ? "paused-draft" : longWaitBanner ? "checking" : loading ? "loading" : "countdown");'''
    )

    replace_once(
        path,
'''    if (!recoveryPhase && !longWaitBanner) countdownUiTimer = setTimeout(publishRecoveryStatus, 1000);''',
'''    if (!recoveryPhase && !longWaitBanner && !loading) countdownUiTimer = setTimeout(publishRecoveryStatus, 1000);'''
    )

    replace_once(
        path,
'''  function runningTool(turn = activeTurn) {
    if (!turn) return false;
    for (const shimmer of turn.querySelectorAll(".loading-shimmer-tertiary")) {''',
'''  function hasAssistantOutput(turn = activeTurn) {
    if (!turn) return false;
    for (const message of turn.querySelectorAll('[data-message-author-role="assistant"]')) {
      if (String(message.textContent || "").trim()) return true;
      if (message.querySelector("img, video, audio, pre, code, table")) return true;
    }
    return false;
  }

  function preOutputLoading(turn = activeTurn) {
    return !!turn && !!turn.querySelector(STREAMING_SELECTOR) && !hasLongWaitBanner(turn) && !hasAssistantOutput(turn);
  }

  function runningTool(turn = activeTurn) {
    if (!turn) return false;
    for (const shimmer of turn.querySelectorAll(".loading-shimmer-tertiary")) {'''
    )

    replace_once(
        path,
'''  function scheduleStallCheck(delayOverride) {
    clearTimer();
    if (!settings.stallRecoveryEnabled || !activeTurn || !stopButton()) { publishRecoveryStatus(); return; }
    const elapsed = Date.now() - lastActivityAt;''',
'''  function scheduleStallCheck(delayOverride) {
    clearTimer();
    if (!settings.stallRecoveryEnabled || !activeTurn || !stopButton()) { publishRecoveryStatus(); return; }
    if (preOutputLoading(activeTurn)) { publishRecoveryStatus(); return; }
    const elapsed = Date.now() - lastActivityAt;'''
    )

    replace_once(
        path,
'''  async function checkForStall() {
    stallTimer = null;
    if (!settings.stallRecoveryEnabled || !activeTurn || !stopButton()) return;
    if (document.visibilityState !== "visible") { installVisibilityWakeup(); return; }''',
'''  async function checkForStall() {
    stallTimer = null;
    if (!settings.stallRecoveryEnabled || !activeTurn || !stopButton()) return;
    if (preOutputLoading(activeTurn)) { publishRecoveryStatus(); return; }
    if (document.visibilityState !== "visible") { installVisibilityWakeup(); return; }'''
    )

    replace_once(
        path,
'''        runningTool: runningTool(),
        longWaitBanner: hasLongWaitBanner(),
        recoveryPhase,''',
'''        runningTool: runningTool(),
        longWaitBanner: hasLongWaitBanner(),
        assistantOutputPresent: hasAssistantOutput(),
        preOutputLoading: preOutputLoading(),
        recoveryPhase,'''
    )

# Shared badge: loading phase has no countdown.
for path in ["firefox/content.js", "chrome/content.js"]:
    replace_once(
        path,
'''  if (status.phase === "paused-hidden") return "auto-continue paused · tab hidden";''',
'''  if (status.phase === "loading") return "response loading · recovery not armed";
  if (status.phase === "paused-hidden") return "auto-continue paused · tab hidden";'''
    )

# Static/unit coverage.
replace_once(
    "tests/test-stall-recovery.js",
'''assert(chromeSource.includes("countdownRemainingMs"), "watchdog debug state must expose the live countdown");''',
'''assert(chromeSource.includes("countdownRemainingMs"), "watchdog debug state must expose the live countdown");
assert(chromeSource.includes("function preOutputLoading"), "pre-output streaming/loading must be a distinct non-armed state");
assert(chromeSource.includes("if (preOutputLoading(activeTurn)) { publishRecoveryStatus(); return; }"), "ordinary stall timer must not arm before assistant output exists");
assert(chromeSource.includes("assistantOutputPresent"), "debug state must expose whether actual assistant output has begun");'''
)

replace_once(
    "tests/test-stall-recovery.js",
'''  assert(content.includes("auto-continue resuming"), `${browser}: status must show active recovery phase`);''',
'''  assert(content.includes("auto-continue resuming"), `${browser}: status must show active recovery phase`);
  assert(content.includes("response loading · recovery not armed"), `${browser}: pre-output loading must not display a retry countdown`);'''
)

# Update accumulator unit expectations for partial snapshots.
test_path = Path("tests/test-paginated-history-accumulator.js")
test = test_path.read_text()
test = test.replace(
'''assert.equal(result.complete, false);
assert.equal(result.continueNativePagination, false, "initial page exposes its own cursor; no synthetic continuation is needed yet");
assert.equal(accumulator.debug().activeCount, 1);''',
'''assert.equal(result.complete, false);
assert.equal(result.continueNativePagination, false, "initial page exposes its own cursor; no synthetic continuation is needed yet");
assert(result.history, "initial newest page must immediately publish a partial local archive");
assert.equal(result.history.complete, false);
assert.equal(result.history.olderPagesPending, true);
assert.deepEqual(result.history.messages.map((entry) => entry.id), ["u3", "a3"]);
assert.equal(accumulator.debug().activeCount, 1);'''
)
test = test.replace(
'''assert.equal(result.complete, false);
assert.equal(result.continueNativePagination, true, "an older page that advertises another cursor must allow the native client to fetch it once");''',
'''assert.equal(result.complete, false);
assert.equal(result.continueNativePagination, true, "an older page that advertises another cursor must allow the native client to fetch it once");
assert(result.history && result.history.complete === false);
assert.deepEqual(result.history.messages.map((entry) => entry.id), ["u2", "a2", "u3", "a3"]);'''
)
test_path.write_text(test)

# E2E fixtures may already contain the pre-output regression case from a preparatory commit.

# Add new unit test to CI if not present.
workflow = Path(".github/workflows/release.yml")
workflow_text = workflow.read_text()
needle = "            tests/test-firefox-conversation-rate-limit-guard.js\n"
addition = needle + "            tests/test-paginated-history-accumulator.js\n"
if "tests/test-paginated-history-accumulator.js" not in workflow_text:
    workflow_text = workflow_text.replace(needle, addition)
workflow.write_text(workflow_text)
