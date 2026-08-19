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

  fetch('/backend-api/conversation/e2e').then((response) => response.json()).then((data) => {
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

async function configure(worker, mode) {
  await worker.evaluate(async ({ mode }) => {
    await chrome.storage.local.set({
      enabled: true,
      mode,
      maxDisplayMessages: 8,
      showGuardNotice: false,
      archiveEnabled: true
    });
  }, { mode });
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
    hasRecentHidden: !!window.__receivedConversation.mapping["hidden-36"]
  }));

  assert.equal(state.visible, 20, "Recent 8 logical units should keep 4 agent exchanges = 20 raw visible records");
  assert(state.nodes < 60, `React/page graph should be bounded, got ${state.nodes} nodes`);
  assert.equal(state.hasOldUser, false, "older visible graph state must be removed before page code receives it");
  assert.equal(state.hasCutoffUser, true, "logical cutoff must retain the first recent exchange");
  assert.equal(state.hasRecentTool, true, "technical nodes inside retained recent state must survive");
  assert.equal(state.hasRecentHidden, true, "hidden nodes inside retained recent state must survive");
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
  assert((await marker.textContent()).includes("72 older turns available"), "archive must retain history React did not receive");

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
    await context.route("https://chatgpt.com/backend-api/conversation/e2e", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fullConversation) });
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
