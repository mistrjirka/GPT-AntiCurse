"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const loadCounts = new Map();

function assistantTurn({ streaming = false, useful = false, error = false } = {}) {
  return `<div data-turn-id-container="turn-1"><section data-testid="conversation-turn-1" data-turn-id="turn-1" data-turn="assistant">
    <div data-message-author-role="assistant" data-message-id="msg-1" data-message-model-slug="gpt-5-6-thinking">
      ${useful ? '<div class="markdown prose"><p>Useful final answer.</p></div>' : ''}
      ${error ? '<div class="text-token-text-error">A network error occurred.<button data-testid="regenerate-thread-error-button">Retry</button></div>' : ''}
    </div>
    ${streaming ? '<div data-streaming-response-status="streaming"><div><span data-testid="cot-v5-tool-icon-pile"></span><span class="loading-shimmer-tertiary">Tool finished</span></div></div>' : ''}
  </section></div>`;
}

function fixtureHtml(id, loadNumber) {
  const networkFirst = id === "network-reload" && loadNumber === 1;
  const streaming = id !== "network-reload" && !networkFirst;
  const useful = id === "useful-answer";
  const error = networkFirst;
  return `<!doctype html><html><head><meta charset="utf-8"><title>post-run</title></head><body>
<div id="main"><div id="turn-list">${assistantTurn({ streaming, useful, error })}</div></div>
<form data-type="unified-composer"><div id="prompt-textarea" contenteditable="true"></div><button id="composer-submit-button" type="button" data-testid="${streaming ? "stop-button" : "send-button"}">${streaming ? "Stop" : "Send"}</button></form>
<script>
(() => {
  const id=${JSON.stringify(id)};
  const button=document.getElementById('composer-submit-button');
  const composer=document.getElementById('prompt-textarea');
  const streamingNode=document.querySelector('[data-streaming-response-status]');
  const state=window.__state={id,loadNumber:${loadNumber},stopClicks:0,sends:Number(sessionStorage.getItem('fixture-sends')||0),sentText:''};
  function setSend(){ button.setAttribute('data-testid','send-button'); button.textContent='Send'; button.disabled=false; streamingNode?.removeAttribute('data-streaming-response-status'); }
  button.addEventListener('click',()=>{
    if(button.getAttribute('data-testid')==='stop-button') { state.stopClicks++; setSend(); return; }
    if(button.disabled) return;
    const text=(composer.textContent||'').trim();
    state.sends++; state.sentText=text; sessionStorage.setItem('fixture-sends',String(state.sends));
    composer.replaceChildren(); button.setAttribute('data-testid','stop-button'); button.textContent='Stop';
  });
  if(id==='tool-ended' || id==='useful-answer') setTimeout(setSend,350);
})();
</script></body></html>`;
}

function isWorker(worker) {
  return /^chrome-extension:\/\//.test(worker.url()) && /\/background-entry\.js(?:$|[?#])/.test(worker.url());
}

async function waitForWorker(context) {
  return context.serviceWorkers().find(isWorker) || context.waitForEvent("serviceworker", isWorker);
}

async function configure(worker) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await worker.evaluate(() => !!globalThis.chrome?.storage?.local).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await worker.evaluate(async () => chrome.storage.local.set({ enabled: false, showGuardNotice: true, stallRecoveryEnabled: true }));
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "anticurse-post-run-chromium-"));
  const extensionPath = path.join(temp, "chrome");
  const userDataDir = path.join(temp, "profile");
  fs.cpSync(path.join(ROOT, "chrome"), extensionPath, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  try {
    await context.route(/https:\/\/chatgpt\.com\/c\/[^/?#]+$/, (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
      const n = (loadCounts.get(id) || 0) + 1;
      loadCounts.set(id, n);
      route.fulfill({ status: 200, contentType: "text/html", body: fixtureHtml(id, n) });
    });
    await context.route("https://chatgpt.com/api/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ accessToken: "post-run-token" }) }));
    await context.route(/https:\/\/chatgpt\.com\/backend-api\/conversation\/[^/]+\/stream_status$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "NOT_STREAMING" }) }));

    const worker = await waitForWorker(context);
    await configure(worker);

    {
      const page = await context.newPage();
      await page.goto("https://chatgpt.com/c/tool-ended", { waitUntil: "load" });
      await page.waitForFunction(() => Number(sessionStorage.getItem('fixture-sends') || 0) === 1, null, { timeout: 5000 });
      const state = await page.evaluate(() => window.__state);
      assert.equal(state.stopClicks, 0, "natural tool-only terminal state must not click Stop");
      assert.equal(state.sentText, ".", "tool-only terminal state must continue with dot");
      assert.equal(loadCounts.get("tool-ended"), 1, "tool-only terminal state must not reload");
      await page.close();
    }

    {
      const page = await context.newPage();
      await page.goto("https://chatgpt.com/c/useful-answer", { waitUntil: "load" });
      await page.waitForTimeout(1400);
      assert.equal(await page.evaluate(() => Number(sessionStorage.getItem('fixture-sends') || 0)), 0, "useful Markdown answer must not auto-continue");
      await page.close();
    }

    {
      const page = await context.newPage();
      await page.goto("https://chatgpt.com/c/manual-stop", { waitUntil: "load" });
      await page.locator('#composer-submit-button[data-testid="stop-button"]').click();
      await page.waitForTimeout(1400);
      const state = await page.evaluate(() => window.__state);
      assert.equal(state.stopClicks, 1, "fixture manual Stop should remain native");
      assert.equal(state.sends, 0, "trusted/manual Stop must suppress post-run auto-continuation");
      await page.close();
    }

    {
      const page = await context.newPage();
      await page.goto("https://chatgpt.com/c/network-reload", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Number(sessionStorage.getItem('fixture-sends') || 0) === 1, null, { timeout: 7000 });
      assert((loadCounts.get("network-reload") || 0) >= 2, "retryable network error must reload before continuation");
      const state = await page.evaluate(() => window.__state);
      assert.equal(state.sentText, ".", "reloaded network-error conversation must continue with dot");
      const debug = await page.evaluate(() => {
        const node = document.documentElement;
        return node ? true : false;
      });
      assert.equal(debug, true);
      await page.close();
    }

    console.log("Chromium post-run recovery E2E: PASS", JSON.stringify(Object.fromEntries(loadCounts)));
  } finally {
    await context.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error && error.stack || error); process.exit(1); });
