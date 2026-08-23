"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

function makeNode(id, parent, role, metadata = {}) {
  return {
    id,
    parent,
    children: [],
    message: role ? {
      author: { role },
      content: { content_type: "text", parts: [id] },
      create_time: 1,
      metadata
    } : null
  };
}

function link(mapping, parent, child) {
  mapping[child].parent = parent;
  mapping[parent].children.push(child);
}

function conversation(exchanges = 40, assistantFragments = 4) {
  const mapping = { root: makeNode("root", null, null) };
  let parent = "root";

  for (let exchange = 0; exchange < exchanges; exchange++) {
    const user = `user-${exchange}`;
    mapping[user] = makeNode(user, parent, "user");
    link(mapping, parent, user);
    parent = user;

    const tool = `tool-${exchange}`;
    mapping[tool] = makeNode(tool, parent, "tool");
    link(mapping, parent, tool);
    parent = tool;

    const hidden = `hidden-${exchange}`;
    mapping[hidden] = makeNode(hidden, parent, "assistant", { is_visually_hidden_from_conversation: true });
    mapping[hidden].message.recipient = "Development_Sandbox.exec_command";
    mapping[hidden].message.content.parts = [JSON.stringify({ path: "/Development_Sandbox/exec_command", args: { command: `echo export-tool-${exchange}` } })];
    link(mapping, parent, hidden);
    parent = hidden;

    for (let fragment = 0; fragment < assistantFragments; fragment++) {
      const assistant = `assistant-${exchange}-${fragment}`;
      mapping[assistant] = makeNode(assistant, parent, "assistant");
      link(mapping, parent, assistant);
      parent = assistant;

      if (fragment < assistantFragments - 1) {
        const between = `tool-${exchange}-between-${fragment}`;
        mapping[between] = makeNode(between, parent, "tool");
        link(mapping, parent, between);
        parent = between;
      }
    }
  }

  return {
    id: "e2e",
    conversation_id: "e2e",
    title: "AntiCurse E2E",
    mapping,
    current_node: parent,
    root: "root"
  };
}

const FIXTURE_HTML = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; font-family: system-ui, sans-serif; }
  [data-scroll-root] { height: 600px; overflow-y: auto; }
  #thread { min-height: 700px; }
  #thread section { padding: 20px 32px; min-height: 28px; border-bottom: 1px solid rgba(0,0,0,.03); }
</style>
</head>
<body>
<script type="application/json" id="client-bootstrap">{"authStatus":"logged_in","session":{"accessToken":"bootstrap-access-token"}}</script>
<div data-scroll-root>
  <div role="presentation" class="contents">
    <div id="thread"></div>
  </div>
</div>
<script>
(() => {
  const root = document.querySelector('[data-scroll-root]');
  const thread = document.querySelector('#thread');

  function updateTopState() {
    if (root.scrollTop > 16) root.setAttribute('data-scroll-from-top', '');
    else root.removeAttribute('data-scroll-from-top');
  }
  root.addEventListener('scroll', updateTopState);

  function hidden(node) {
    const metadata = node && node.message && node.message.metadata;
    return !!(metadata && (metadata.is_visually_hidden_from_conversation === true || metadata.is_user_system_message === true));
  }

  function role(node) {
    return node && node.message && node.message.author && node.message.author.role;
  }

  function chain(data) {
    const result = [];
    const seen = new Set();
    let id = data.current_node;
    while (id && data.mapping[id] && !seen.has(id)) {
      seen.add(id);
      result.push(id);
      id = data.mapping[id].parent || null;
    }
    return result.reverse();
  }

  function normalizePaginated(raw) {
    if (!raw || !Array.isArray(raw.messages)) return raw;
    const mapping = {};
    let parent = null;
    for (const message of raw.messages) {
      if (!message || !message.id) continue;
      const id = message.id;
      mapping[id] = { id, message, parent, children: [] };
      if (parent && mapping[parent]) mapping[parent].children = [id];
      parent = id;
    }
    const current = raw.current_node && mapping[raw.current_node] ? raw.current_node : parent;
    return { ...raw, mapping, current_node: current, root: null };
  }

  fetch('/backend-api/conversations/e2e?include_has_versions=true&num_turns=10').then((response) => response.json()).then(async (raw) => {
    window.__receivedCursor = raw.page_info?.has_previous_page === true ? (raw.page_info.start_cursor ?? null) : null;
    window.__nativePaginationRequests = 0;
    // Preserve truthful pagination metadata on the newest page. AntiCurse
    // terminates the actual older-page response instead.
    while (raw.page_info?.has_previous_page === true && raw.page_info.start_cursor) {
      window.__nativePaginationRequests++;
      const cursor = raw.page_info.start_cursor;
      const older = await fetch('/backend-api/conversations/e2e/messages?include_has_versions=true&num_turns=10&before=' + encodeURIComponent(cursor)).then((response) => response.json());
      raw.messages = (older.messages || []).concat(raw.messages || []);
      raw.page_info = older.page_info || {};
    }
    const data = normalizePaginated(raw);
    window.__receivedConversation = data;
    let visible = 0;
    for (const id of chain(data)) {
      const node = data.mapping[id];
      const r = role(node);
      if (hidden(node) || (r !== 'user' && r !== 'assistant')) continue;
      visible++;
      const section = document.createElement('section');
      section.dataset.testid = 'conversation-turn-' + visible;
      section.setAttribute('data-testid', 'conversation-turn-' + visible);
      const message = document.createElement('div');
      message.setAttribute('data-message-author-role', r);
      message.textContent = node.message.content.parts.join('\n');
      section.append(message);
      thread.append(section);
    }
    window.__nativeVisible = visible;
    window.__receivedMappingNodes = Object.keys(data.mapping).length;
    window.__ready = true;
    root.scrollTop = root.scrollHeight;
    updateTopState();
    root.dispatchEvent(new Event('scroll', { bubbles: true }));
  }).catch((error) => {
    window.__fixtureError = String(error && error.stack || error);
  });
})();
</script>
</body>
</html>`;

function isAntiCurseWorker(worker) {
  return /^chrome-extension:\/\//.test(worker.url()) && /\/background-entry\.js(?:$|[?#])/.test(worker.url());
}

async function waitForServiceWorker(context) {
  const existing = context.serviceWorkers().find(isAntiCurseWorker);
  if (existing) return existing;
  return context.waitForEvent("serviceworker", isAntiCurseWorker);
}


async function waitForStorageApi(worker) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const ready = await worker.evaluate(() => !!(globalThis.chrome && chrome.storage && chrome.storage.local)).catch(() => false);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Chromium extension storage API did not become ready");
}

async function configure(worker, mode) {
  await waitForStorageApi(worker);
  await worker.evaluate(async ({ mode }) => {
    await chrome.storage.local.set({
      enabled: true,
      mode,
      maxDisplayMessages: 8,
      showGuardNotice: false
    });
  }, { mode });
}

async function buildExportArchiveFromPage(worker) {
  return worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    const tab = tabs[tabs.length - 1];
    if (!tab) return { ok: false, reason: "fixture-tab-not-found" };
    return chrome.tabs.sendMessage(tab.id, { type: "cg-build-export-archive" });
  });
}

async function contentDebug(worker) {
  return worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    const tab = tabs[tabs.length - 1];
    if (!tab) return { ok: false, error: "fixture tab not found" };
    try {
      return await chrome.tabs.sendMessage(tab.id, { type: "cg-get-debug-state" });
    } catch (error) {
      return { ok: false, error: String(error && error.message || error) };
    }
  });
}

async function openFixture(context) {
  const page = await context.newPage();
  await page.goto("https://chatgpt.com/c/e2e", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ready === true || !!window.__fixtureError);
  const error = await page.evaluate(() => window.__fixtureError || null);
  assert.equal(error, null, error || "fixture fetch failed");
  return page;
}

async function assertTrimInvariant(page) {
  const state = await page.evaluate(() => ({
    visible: window.__nativeVisible,
    nodes: window.__receivedMappingNodes,
    hasOldUser: !!window.__receivedConversation.mapping["user-35"],
    hasCutoffUser: !!window.__receivedConversation.mapping["user-36"],
    hasRecentTool: !!window.__receivedConversation.mapping["tool-36"],
    hasRecentHidden: !!window.__receivedConversation.mapping["hidden-36"],
    cursor: window.__receivedCursor,
    nativePaginationRequests: window.__nativePaginationRequests
  }));

  assert.equal(state.visible, 20, "Recent 8 logical units should keep 4 agent exchanges = 20 raw visible records");
  assert(state.nodes < 60, `React/page graph should be bounded, got ${state.nodes} nodes`);
  assert.equal(state.hasOldUser, false, "older visible graph state must be removed before page code receives it");
  assert.equal(state.hasCutoffUser, true, "logical cutoff must retain the first recent exchange");
  assert.equal(state.hasRecentTool, true, "technical nodes inside retained recent state must survive");
  assert.equal(state.hasRecentHidden, true, "hidden nodes inside retained recent state must survive");
  assert.equal(state.cursor, "older-page-2", "newest page must preserve ChatGPT's real pagination cursor");
  assert.equal(state.nativePaginationRequests, 1, "native pagination may request one older page, which AntiCurse terminates before its records enter React");
}


async function assertUnderLimitAgentCompaction(page) {
  const state = await page.evaluate(() => {
    function make(id, parent, role, recipient = "") {
      return {
        id,
        parent,
        children: [],
        message: role ? {
          author: { role },
          recipient,
          metadata: {},
          content: { content_type: "text", parts: [id] }
        } : null
      };
    }
    function attach(mapping, parent, child) {
      mapping[child].parent = parent;
      mapping[parent].children.push(child);
    }

    const mapping = { root: make("root", null, null) };
    let parent = "root";
    for (let exchange = 0; exchange < 13; exchange++) {
      const user = `agent-user-${exchange}`;
      mapping[user] = make(user, parent, "user");
      attach(mapping, parent, user);
      parent = user;
      for (let call = 0; call < 5; call++) {
        const toolCall = `agent-call-${exchange}-${call}`;
        mapping[toolCall] = make(toolCall, parent, "assistant", "tool");
        attach(mapping, parent, toolCall);
        parent = toolCall;
        const toolResult = `agent-result-${exchange}-${call}`;
        mapping[toolResult] = make(toolResult, parent, "tool");
        attach(mapping, parent, toolResult);
        parent = toolResult;
        const progress = `agent-progress-${exchange}-${call}`;
        mapping[progress] = make(progress, parent, "assistant");
        attach(mapping, parent, progress);
        parent = progress;
      }
      const answer = `agent-answer-${exchange}`;
      mapping[answer] = make(answer, parent, "assistant");
      attach(mapping, parent, answer);
      parent = answer;
    }

    const source = { mapping, current_node: parent, root: "root" };
    const before = Object.keys(mapping).length;
    const result = globalThis.CGTrim.trimConversation(source, { mode: "recent", maxDisplayMessages: 64 });
    return {
      before,
      after: Object.keys(result.data.mapping).length,
      changed: result.changed,
      reason: result.reason,
      logicalBefore: result.stats.logicalDisplayBefore,
      logicalAfter: result.stats.logicalDisplayAfter,
      technicalCompaction: result.stats.technicalCompaction,
      technicalNodesDropped: result.stats.technicalNodesDropped,
      oldUser: !!result.data.mapping["agent-user-0"],
      oldFinal: !!result.data.mapping["agent-answer-0"],
      oldProgress: !!result.data.mapping["agent-progress-0-0"],
      oldTool: !!result.data.mapping["agent-result-0-0"],
      olderRecentTool: !!result.data.mapping["agent-result-9-0"],
      newestTool: !!result.data.mapping["agent-result-12-0"],
      currentPreserved: result.data.current_node === source.current_node
    };
  });

  assert.equal(state.logicalBefore, 26, "agentic regression fixture must stay below Recent 64");
  assert.equal(state.logicalAfter, 26, "technical compaction must preserve all logical conversation units");
  assert.equal(state.changed, true, "pathological under-limit agent state must be trimmed");
  assert.equal(state.reason, "trimmed");
  assert.equal(state.technicalCompaction, true);
  assert(state.after < state.before * 0.5, `agentic native graph should shrink substantially: ${JSON.stringify(state)}`);
  assert.equal(state.oldUser, true);
  assert.equal(state.oldFinal, true);
  assert.equal(state.oldProgress, false);
  assert.equal(state.oldTool, false);
  assert.equal(state.olderRecentTool, false, "raw-node budget should compact older tool-heavy exchanges even inside the logical tail");
  assert.equal(state.newestTool, true, "newest exchange technical state must remain intact");
  assert.equal(state.currentPreserved, true);
}

async function recentPagingTest(context, worker) {
  await configure(worker, "recent");
  const page = await openFixture(context);
  await assertTrimInvariant(page);

  // Export is now one-shot and memory-only. An explicit request must capture
  // the untouched old history plus the current rendered tail without involving
  // the Chromium service worker or IndexedDB.
  const exported = await buildExportArchiveFromPage(worker);
  assert.equal(exported && exported.ok, true, `explicit in-memory export capture failed: ${JSON.stringify(exported)}`);
  assert.equal(exported.authoritative, true, "Chromium export must refetch the authoritative conversation instead of relying on transient visible history");
  assert.equal(exported.sourcePages, 2, "long export must merge every cursor page before extraction");
  assert(exported.baseArchive && Array.isArray(exported.baseArchive.messages), "export capture must return an authoritative raw-graph archive");
  assert(exported.baseArchive.messages.some((message) => /user-0/.test(message.text || "")), "one-shot export must retain older history omitted from React");
  const oldTool = exported.baseArchive.messages.find((message) => message.id === "hidden-0");
  assert(oldTool, "authoritative export must recover an old explicit tool call hidden from the page graph");
  assert.equal(oldTool.recipient, "Development_Sandbox.exec_command");
  assert((oldTool.text || "").includes("export-tool-0"));
  assert.equal(exported.baseArchive.id, "e2e");
  assert(Array.isArray(exported.rendered), "export capture must include the current rendered tail for one-shot merging");

  const bootstrapExport = await buildExportArchiveFromPage(worker);
  assert.equal(bootstrapExport && bootstrapExport.ok, true, `client-bootstrap auth fallback failed: ${JSON.stringify(bootstrapExport)}`);
  assert.equal(bootstrapExport.authoritative, true);
  assert.equal(bootstrapExport.sourceAuth, "client-bootstrap", "failed auth-session lookup should fall back to the page bootstrap token");
  assert.equal(bootstrapExport.sourcePages, 2);
  assert(bootstrapExport.baseArchive.messages.some((message) => message.id === "hidden-0"), "bootstrap-auth export must remain complete across cursor pages");

  const pluralExport = await buildExportArchiveFromPage(worker);
  assert.equal(pluralExport && pluralExport.ok, true, `plural export fallback failed: ${JSON.stringify(pluralExport)}`);
  assert.equal(pluralExport.authoritative, true);
  assert.equal(pluralExport.sourceEndpointFamily, "conversations", "retired singular export route must fall back to plural");
  assert.equal(pluralExport.sourcePages, 2, "plural export fallback must keep walking cursor pages");
  assert(pluralExport.baseArchive.messages.some((message) => message.id === "hidden-0"), "plural export fallback must remain complete");

  const fallback = await buildExportArchiveFromPage(worker);
  assert.equal(fallback && fallback.ok, true, `temporary authoritative-fetch failure must still produce a fallback export: ${JSON.stringify(fallback)}`);
  assert.equal(fallback.authoritative, false, "fallback export must never claim authoritative completeness");
  assert.equal(fallback.sourceReason, "http-status");
  assert(fallback.baseArchive && fallback.baseArchive.complete === false, "fallback archive must be explicitly partial");
  assert(fallback.baseArchive.messages.some((message) => /user-39/.test(message.text || "")), "partial fallback should preserve the newest transient page");
  assert.equal(fallback.baseArchive.messages.some((message) => /user-0/.test(message.text || "")), false, "partial fallback must not pretend cursor-omitted history was captured");
  await assertUnderLimitAgentCompaction(page);

  const button = page.locator("#cg-window-history-host .cg-history-previous");
  try {
    await button.waitFor({ state: "visible" });
  } catch (error) {
    console.error("history debug", JSON.stringify(await contentDebug(worker)));
    throw error;
  }
  assert.equal(await button.textContent(), "Load previous 8");

  const marker = page.locator("#cg-window-history-host .cg-history-marker");
  assert((await marker.textContent()).includes("72 older turns available"), "private cursor fetch must retain history React did not receive");
  const historyHealth = await contentDebug(worker);
  assert.equal(historyHealth?.state?.historyController?.nativeTrimConfirmed, true, "plural initial response must confirm native trimming before history is requested");
  assert.equal(historyHealth?.state?.historyController?.historyPresent, true, "plural initial response must make private window history available");
  assert.equal(historyHealth?.state?.historyController?.historyConversationId, "e2e");
  assert.equal(historyHealth?.state?.archiveBridge?.paginationCursorPreserved, true, "initial OpenAI cursor must remain private in the isolated bridge");
  assert.equal(historyHealth?.state?.archiveBridge?.fullVisibleArchive, true, "Load previous must rebuild complete lightweight history privately");

  for (let index = 0; index < 8; index++) {
    await page.evaluate(() => {
      const root = document.querySelector('[data-scroll-root]');
      root.scrollTop = 0;
      root.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await button.click();
    await page.waitForTimeout(40);
  }

  const markerAfter = await marker.textContent();
  const bounded = await page.evaluate(() => {
    const top = document.querySelector("#cg-window-history-host .cg-history-spacer-top");
    const bottom = document.querySelector("#cg-window-history-host .cg-history-spacer-bottom");
    const root = document.querySelector('[data-scroll-root]');
    return {
      pages: document.querySelectorAll("#cg-window-history-host .cg-history-page").length,
      turns: document.querySelectorAll("#cg-window-history-host .cg-history-turn").length,
      starts: Array.from(document.querySelectorAll("#cg-window-history-host .cg-history-page")).map((element) => element.getAttribute("data-cg-start")),
      topInline: parseFloat(top.style.height) || 0,
      bottomInline: parseFloat(bottom.style.height) || 0,
      topComputed: parseFloat(getComputedStyle(top).height) || 0,
      bottomComputed: parseFloat(getComputedStyle(bottom).height) || 0,
      topHidden: top.hidden,
      bottomHidden: bottom.hidden,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
      nativeSyntheticAttrs: document.querySelectorAll("#cg-window-history-host [data-message-author-role], #cg-window-history-host [data-turn-id]").length
    };
  });
  console.log("recent virtualization state", JSON.stringify({ markerAfter, ...bounded }));

  assert(markerAfter.includes("64 older turns loaded"), `eight clicks should load 64 logical turns; marker=${markerAfter}`);
  assert(bounded.pages <= 3, `only ~3 archived pages should stay mounted, got ${bounded.pages}`);
  assert(bounded.turns <= 24, `logical page grouping should bound synthetic turn DOM, got ${bounded.turns}`);
  assert(bounded.topInline + bounded.bottomInline > 0, `evicted pages need inline spacer geometry: ${JSON.stringify(bounded)}`);
  assert(
    (bounded.topInline > 0 && !bounded.topHidden) || (bounded.bottomInline > 0 && !bounded.bottomHidden),
    `non-empty spacer must be visible: ${JSON.stringify(bounded)}`
  );
  assert.equal(bounded.nativeSyntheticAttrs, 0, "synthetic history must never impersonate React-owned native turns");

  const firstStart = await page.locator("#cg-window-history-host .cg-history-page").first().getAttribute("data-cg-start");
  await page.evaluate(({ useBottom }) => {
    const root = document.querySelector('[data-scroll-root]');
    root.scrollTop = useBottom ? root.scrollHeight : 0;
    root.dispatchEvent(new Event('scroll', { bubbles: true }));
  }, { useBottom: bounded.bottomInline > 0 });
  await page.waitForFunction((start) => {
    const mounted = document.querySelector("#cg-window-history-host .cg-history-page");
    return mounted && mounted.getAttribute("data-cg-start") !== start;
  }, firstStart);

  await page.close();
}

async function autoWindowTest(context, worker) {
  await configure(worker, "windowed-visible");
  const page = await openFixture(context);
  await assertTrimInvariant(page);

  const control = page.locator("#cg-window-history-host .cg-history-control");
  await control.waitFor({ state: "attached" });
  assert.equal(await control.isVisible(), false, "Auto window should not show the manual button");
  assert.equal(await page.locator("#cg-window-history-host .cg-history-page").count(), 0);

  await page.evaluate(() => {
    const root = document.querySelector('[data-scroll-root]');
    root.scrollTop = root.scrollHeight;
    root.dispatchEvent(new Event('scroll', { bubbles: true }));
    root.scrollTop = 0;
    root.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll("#cg-window-history-host .cg-history-page").length > 0);
  assert((await page.locator("#cg-window-history-host .cg-history-page").count()) <= 3);
  await page.close();
}

function paginatedConversationPages(full) {
  const entries = Object.entries(full.mapping);
  const split = Math.floor(entries.length / 2);
  return {
    first: {
      id: full.id,
      conversation_id: full.conversation_id,
      title: full.title,
      mapping: Object.fromEntries(entries.slice(split)),
      current_node: full.current_node,
      root: full.root,
      cursor: "older-page-2"
    },
    second: {
      id: full.id,
      conversation_id: full.conversation_id,
      title: full.title,
      mapping: Object.fromEntries(entries.slice(0, split)),
      cursor: null
    }
  };
}

function rawPaginatedConversationPages(full) {
  const chain = [];
  const seen = new Set();
  let id = full.current_node;
  while (id && full.mapping[id] && !seen.has(id)) {
    seen.add(id);
    const node = full.mapping[id];
    if (node.message) chain.push({ ...node.message, id });
    id = node.parent || null;
  }
  chain.reverse();
  // This fixture has 10 raw records per exchange. Keep the newest 20 exchanges
  // in the current document response and expose the oldest 20 through `before`.
  const split = Math.max(0, chain.length - 200);
  return {
    first: {
      id: full.id, conversation_id: full.conversation_id, title: full.title,
      messages: chain.slice(split), current_node: full.current_node,
      page_info: { has_previous_page: true, start_cursor: "older-page-2" }
    },
    second: {
      id: full.id, conversation_id: full.conversation_id, title: full.title,
      messages: chain.slice(0, split), current_node: chain[split - 1]?.id || null,
      page_info: { has_previous_page: false, start_cursor: null }
    }
  };
}

(async () => {
  const extensionPath = path.resolve(__dirname, "..", "chrome");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "anticurse-e2e-"));
  const fullConversation = conversation();

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  try {
    await context.route("https://chatgpt.com/c/e2e", async (route) => {
      await route.fulfill({ status: 200, contentType: "text/html", body: FIXTURE_HTML });
    });
    const pages = paginatedConversationPages(fullConversation);
    const rawPages = rawPaginatedConversationPages(fullConversation);
    let authSessionRequests = 0;
    let exportStarts = 0;
    await context.route("https://chatgpt.com/api/auth/session", async (route) => {
      authSessionRequests++;
      // #1 is the authoritative lightweight-history fetch; #2 is the first
      // explicit Export. #3 intentionally fails to exercise client-bootstrap.
      if (authSessionRequests !== 3) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ accessToken: "e2e-access-token" })
        });
        return;
      }
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "auth fixture unavailable" }) });
    });
    await context.route(/https:\/\/chatgpt\.com\/backend-api\/conversations?\/e2e(?:\?.*)?$/, async (route) => {
      const request = route.request();
      const auth = request.headers()["authorization"] || "";
      const url = new URL(request.url());
      const plural = url.pathname === "/backend-api/conversations/e2e";
      if (!auth) {
        assert.equal(plural, true, "ChatGPT fixture must use the current plural conversation document endpoint");
        assert.equal(url.searchParams.get("include_has_versions"), "true");
        assert.equal(url.searchParams.get("num_turns"), "10");
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rawPages.first) });
        return;
      }

      assert(["Bearer e2e-access-token", "Bearer bootstrap-access-token"].includes(auth), `unexpected export auth: ${auth}`);
      const cursor = url.searchParams.get("cursor");
      if (!cursor && !plural) {
        exportStarts++;
        // Fourth authoritative operation: retire singular and prove a complete
        // current plural fallback. Fifth: a real server failure stays partial.
        if (exportStarts === 4) {
          await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "singular retired" }) });
          return;
        }
        if (exportStarts === 5) {
          await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary export fixture failure" }) });
          return;
        }
      }

      if (plural) {
        assert.equal(url.searchParams.get("include_has_versions"), "true");
        assert.equal(url.searchParams.get("num_turns"), "10");
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rawPages.first) });
        return;
      }
      if (cursor) assert.equal(cursor, "older-page-2", "legacy singular export must follow its cursor");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(cursor ? pages.second : pages.first) });
    });

    await context.route(/https:\/\/chatgpt\.com\/backend-api\/conversations\/e2e\/messages(?:\?.*)?$/, async (route) => {
      const request = route.request();
      const auth = request.headers()["authorization"] || "";
      // The real ChatGPT page now sees the truthful newest-page cursor and may
      // make one native before-page request with no Authorization header. The
      // isolated AntiCurse archive/export fetch remains authenticated.
      if (auth) {
        assert(["Bearer e2e-access-token", "Bearer bootstrap-access-token"].includes(auth), `unexpected paginated export auth: ${auth}`);
      }
      const url = new URL(request.url());
      assert.equal(url.searchParams.get("include_has_versions"), "true");
      assert.equal(url.searchParams.get("num_turns"), "10");
      assert.equal(url.searchParams.get("before"), "older-page-2");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rawPages.second) });
    });

    const worker = await waitForServiceWorker(context);
    assert(isAntiCurseWorker(worker), `unexpected AntiCurse service worker URL: ${worker.url()}`);

    await recentPagingTest(context, worker);
    await autoWindowTest(context, worker);
    console.log("Chromium extension E2E: PASS");
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
