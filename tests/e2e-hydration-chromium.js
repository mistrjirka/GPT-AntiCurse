"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

function makeConversation(turns = 16) {
  const mapping = {
    root: { id: "root", parent: null, children: [], message: null }
  };
  let parent = "root";
  for (let i = 0; i < turns; i++) {
    const id = `turn-${i}`;
    const role = i % 2 === 0 ? "user" : "assistant";
    mapping[id] = {
      id,
      parent,
      children: [],
      message: {
        author: { role },
        content: { content_type: "text", parts: [`${role} ${i}`] },
        create_time: i + 1,
        metadata: {}
      }
    };
    mapping[parent].children.push(id);
    parent = id;
  }
  return {
    id: "hydration-e2e",
    conversation_id: "hydration-e2e",
    title: "Hydration boundary",
    mapping,
    current_node: parent,
    root: "root"
  };
}

const FIXTURE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>[data-scroll-root]{height:500px;overflow-y:auto}#thread{min-height:600px}</style>
</head>
<body>
<div data-scroll-root data-scroll-from-end="">
  <main id="main">
    <div role="presentation" class="contents">
      <div id="thread">
        <section data-testid="conversation-turn-ssr"><div data-message-author-role="assistant">SSR conversation snapshot</div></section>
      </div>
    </div>
  </main>
</div>
<img src="/hydration-blocker.svg" alt="" hidden>
<script>
window.__fetchStarted = true;
fetch('/backend-api/conversation/hydration-e2e')
  .then((response) => response.json())
  .then((data) => {
    window.__receivedConversation = data;
    window.__receivedNodes = Object.keys(data.mapping || {}).length;
    window.__fetchDone = true;
  })
  .catch((error) => { window.__fixtureError = String(error && error.stack || error); });
</script>
</body>
</html>`;

async function waitForServiceWorker(context) {
  const existing = context.serviceWorkers();
  if (existing.length) return existing[0];
  return context.waitForEvent("serviceworker");
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

(async () => {
  const extensionPath = path.resolve(__dirname, "..", "chrome");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "anticurse-hydration-"));
  const fullConversation = makeConversation();
  const fullNodeCount = Object.keys(fullConversation.mapping).length;

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  try {
    await context.route("https://chatgpt.com/c/hydration-e2e", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: FIXTURE_HTML }));
    await context.route("https://chatgpt.com/backend-api/conversation/hydration-e2e", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fullConversation) }));
    await context.route("https://chatgpt.com/hydration-blocker.svg", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
    });

    const worker = await waitForServiceWorker(context);
    await waitForStorageApi(worker);
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        enabled: true,
        mode: "recent",
        maxDisplayMessages: 4,
        showGuardNotice: true,
      });
    });

    const page = await context.newPage();
    await page.goto("https://chatgpt.com/c/hydration-e2e", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__fetchStarted === true);
    await page.waitForTimeout(200);

    const beforeLoad = await page.evaluate(() => ({
      readyState: document.readyState,
      host: !!document.querySelector("#cg-window-history-host"),
      badge: !!document.querySelector("#cg-conversation-guard-status"),
      fetchDone: window.__fetchDone === true,
      fixtureError: window.__fixtureError || null
    }));
    console.log("hydration pre-load state", JSON.stringify(beforeLoad));
    assert.equal(beforeLoad.fixtureError, null, beforeLoad.fixtureError || "fixture failed");
    assert.notEqual(beforeLoad.readyState, "complete", "blocker must keep the load boundary open");
    assert.equal(beforeLoad.fetchDone, false, "conversation data must not reach React while SSR hydration is still open");
    assert.equal(beforeLoad.host, false, "history DOM must not modify the SSR conversation tree before hydration settles");
    assert.equal(beforeLoad.badge, false, "status badge must not modify document HTML before hydration settles");

    await page.waitForLoadState("load");
    await page.waitForFunction(() => window.__fetchDone === true || !!window.__fixtureError, null, { timeout: 5000 });
    const fixtureError = await page.evaluate(() => window.__fixtureError || null);
    assert.equal(fixtureError, null, fixtureError || "fixture failed");
    const receivedNodes = await page.evaluate(() => window.__receivedNodes);
    assert(receivedNodes < fullNodeCount, "React/page must receive only the bounded graph after hydration");

    await page.locator("#cg-window-history-host").waitFor({ state: "attached", timeout: 5000 });
    await page.locator("#cg-conversation-guard-status").waitFor({ state: "attached", timeout: 5000 });
    const button = page.locator("#cg-window-history-host .cg-history-previous");
    await button.waitFor({ state: "visible", timeout: 10000 });
    assert.equal(await button.textContent(), "Load previous 4");

    console.log("Chromium hydration-boundary E2E: PASS");
    await page.close();
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
