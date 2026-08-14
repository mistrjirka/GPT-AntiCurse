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

async function waitForServiceWorker(context) {
  const existing = context.serviceWorkers();
  if (existing.length) return existing[0];
  return context.waitForEvent("serviceworker");
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

async function openFixture(context, fullConversation) {
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

async function recentPagingTest(context, worker) {
  await configure(worker, "recent");
  const page = await openFixture(context);
  await assertTrimInvariant(page);

  const button = page.locator("#cg-window-history-host .cg-history-previous");
  await button.waitFor({ state: "visible" });
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

  const bounded = await page.evaluate(() => ({
    pages: document.querySelectorAll("#cg-window-history-host .cg-history-page").length,
    turns: document.querySelectorAll("#cg-window-history-host .cg-history-turn").length,
    bottomSpacer: parseFloat(getComputedStyle(document.querySelector("#cg-window-history-host .cg-history-spacer-bottom")).height) || 0,
    nativeSyntheticAttrs: document.querySelectorAll("#cg-window-history-host [data-message-author-role], #cg-window-history-host [data-turn-id]").length
  }));
  assert(bounded.pages <= 3, `only ~3 archived pages should stay mounted, got ${bounded.pages}`);
  assert(bounded.turns <= 24, `logical page grouping should bound synthetic turn DOM, got ${bounded.turns}`);
  assert(bounded.bottomSpacer > 0, "evicted loaded pages should be represented by a measured spacer");
  assert.equal(bounded.nativeSyntheticAttrs, 0, "synthetic history must never impersonate React-owned native turns");

  const firstStart = await page.locator("#cg-window-history-host .cg-history-page").first().getAttribute("data-cg-start");
  await page.evaluate(() => {
    const root = document.querySelector('[data-scroll-root]');
    root.scrollTop = root.scrollHeight;
    root.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForFunction((start) => {
    const page = document.querySelector("#cg-window-history-host .cg-history-page");
    return page && page.getAttribute("data-cg-start") !== start;
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
    assert(worker.url().startsWith("chrome-extension://"), `unexpected service worker URL: ${worker.url()}`);

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
