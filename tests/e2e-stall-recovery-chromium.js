"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");

function fixtureHtml() {
  return String.raw`<!doctype html><html><head><meta charset="utf-8"><title>AntiCurse recovery E2E</title></head><body>
<div id="main"><div id="turn-list"></div></div>
<form data-type="unified-composer">
  <button class="__composer-pill" type="button"><span data-animated-slider-trigger="true"></span></button>
  <div id="prompt-textarea" contenteditable="true"></div>
  <button id="composer-submit-button" type="button"></button>
</form>
<script>
(() => {
  const id = location.pathname.split('/').pop();
  const stateKey = '__ac_fixture_state:' + id;
  const previous = JSON.parse(sessionStorage.getItem(stateKey) || '{}');
  const persistent = {
    loads: Number(previous.loads || 0) + 1,
    stopClicks: Number(previous.stopClicks || 0),
    sends: Number(previous.sends || 0),
    sentText: previous.sentText || '',
    trustedInputEvents: Number(previous.trustedInputEvents || 0)
  };
  const save = () => sessionStorage.setItem(stateKey, JSON.stringify(persistent));
  save();

  const list = document.getElementById('turn-list');
  const composer = document.getElementById('prompt-textarea');
  const form = composer.closest('form');
  const button = document.getElementById('composer-submit-button');
  const modelLabel = document.querySelector('[data-animated-slider-trigger="true"]');
  const secondLoad = persistent.loads >= 2;
  modelLabel.textContent = id === 'reload-pro' && secondLoad ? 'Pro' : 'Thinking';

  window.__state = persistent;
  function syncState() { Object.assign(window.__state, persistent); save(); }

  function makeTurn(index, { output = true, streaming = true, model = 'gpt-5-6-thinking' } = {}) {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-turn-id-container', 'turn-' + index);
    const section = document.createElement('section');
    section.setAttribute('data-testid', 'conversation-turn-' + index);
    section.setAttribute('data-turn-id', 'turn-' + index);
    section.setAttribute('data-turn', 'assistant');
    const message = document.createElement('div');
    message.setAttribute('data-message-author-role', 'assistant');
    message.setAttribute('data-message-model-slug', model);
    if (output) {
      const markdown = document.createElement('div');
      markdown.className = 'markdown';
      markdown.textContent = 'assistant output ' + index;
      message.append(markdown);
    }
    section.append(message);
    const stream = document.createElement('div');
    if (streaming) stream.setAttribute('data-streaming-response-status', 'streaming');
    section.append(stream);
    wrapper.append(section);
    list.append(wrapper);
    return { wrapper, stream, message };
  }

  function setStop() {
    button.setAttribute('data-testid', 'stop-button');
    button.textContent = 'Stop';
    button.disabled = false;
  }
  function setSend(disabled = false) {
    button.setAttribute('data-testid', 'send-button');
    button.textContent = 'Send';
    button.disabled = disabled;
  }

  const reloadCase = id.startsWith('reload-') || id === 'pre-output-reload' || id === 'shell-loading-reload';
  let active = null;
  if (reloadCase && secondLoad) {
    if (id === 'reload-running' || id === 'reload-loop') {
      active = makeTurn(1, { output: true, streaming: true });
      setStop();
    } else if (id === 'reload-stopped-stale') {
      makeTurn(0, { output: true, streaming: true });
      active = makeTurn(1, { output: true, streaming: false });
      setSend(false);
    } else {
      active = makeTurn(1, { output: true, streaming: false });
      setSend(id === 'reload-send-not-ready');
    }
  } else if (id === 'shell-loading-reload') {
    form.setAttribute('inert', '');
    document.documentElement.setAttribute('data-stream-active', 'true');
    setStop();
  } else {
    active = makeTurn(1, { output: id !== 'pre-output-reload', streaming: true });
    setStop();
  }

  if (id === 'stale-stop' && active) {
    const stale = makeTurn(-1, { output: true, streaming: true });
    list.insertBefore(stale.wrapper, active.wrapper);
  }
  if (id === 'system-delay-banner' && active) {
    const banner = document.createElement('span');
    banner.className = 'loading-shimmer-tertiary';
    banner.append('Our systems are thinking a bit more about this request before responding. ');
    const link = document.createElement('a');
    link.href = 'https://help.openai.com/articles/20001326';
    link.textContent = 'Learn more';
    banner.append(link);
    active.stream.append(banner);
  }
  if (id === 'draft-protection') composer.textContent = 'do not overwrite me';

  composer.addEventListener('input', (event) => {
    if (event.isTrusted) persistent.trustedInputEvents++;
    if (id === 'controlled-editor' && event.isTrusted && (composer.textContent || '').trim() === '.' && button.getAttribute('data-testid') !== 'stop-button') {
      button.disabled = false;
    }
    syncState();
  });

  button.addEventListener('click', () => {
    if (button.getAttribute('data-testid') === 'stop-button') {
      persistent.stopClicks++;
      syncState();
      if (id === 'reload-loop' && secondLoad) return;
      setSend(id === 'controlled-editor' || id === 'reload-send-not-ready');
      if (id === 'slow-stop') {
        setTimeout(() => {
          active?.stream?.removeAttribute('data-streaming-response-status');
          button.disabled = false;
        }, 650);
      } else {
        active?.stream?.removeAttribute('data-streaming-response-status');
      }
      return;
    }
    if (button.disabled) return;
    persistent.sends++;
    persistent.sentText = (composer.textContent || '').trim();
    syncState();
    composer.replaceChildren();
    active = makeTurn(10 + persistent.sends, { output: true, streaming: true });
    setStop();
  });
})();
</script></body></html>`;
}

function isAntiCurseWorker(worker) {
  return /^chrome-extension:\/\//.test(worker.url()) && /\/background-entry\.js(?:$|[?#])/.test(worker.url());
}
async function waitForWorker(context) {
  return context.serviceWorkers().find(isAntiCurseWorker) || context.waitForEvent("serviceworker", isAntiCurseWorker);
}
async function waitForStorageApi(worker) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await worker.evaluate(() => !!(globalThis.chrome && chrome.storage && chrome.storage.local)).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Chromium extension storage API did not become ready");
}
async function configure(worker) {
  await waitForStorageApi(worker);
  await worker.evaluate(async () => chrome.storage.local.set({ enabled: false, showGuardNotice: true, stallRecoveryEnabled: true }));
}
async function openCase(context, id) {
  const page = await context.newPage();
  await page.goto(`https://chatgpt.com/c/${id}`, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__state);
  return page;
}
async function state(page) {
  return page.evaluate(() => ({ ...window.__state, draft: document.querySelector('#prompt-textarea')?.textContent || '', href: location.href }));
}

(async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anticurse-stall-e2e-"));
  const extensionPath = path.join(tempRoot, "chrome");
  const userDataDir = path.join(tempRoot, "profile");
  fs.cpSync(path.join(ROOT, "chrome"), extensionPath, { recursive: true });
  const watchdogPath = path.join(extensionPath, "stall-recovery.js");
  let watchdog = fs.readFileSync(watchdogPath, "utf8");
  watchdog = watchdog
    .replace("const STALL_TIMEOUT_MS = 120_000;", "const STALL_TIMEOUT_MS = 200;")
    .replace("const PHASE_TIMEOUT_MS = 120_000;", "const PHASE_TIMEOUT_MS = 1_500;")
    .replace("const SEND_CONFIRM_TIMEOUT_MS = 30_000;", "const SEND_CONFIRM_TIMEOUT_MS = 1_500;");
  fs.writeFileSync(watchdogPath, watchdog);

  const statusCounts = new Map();
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  try {
    await context.route(/https:\/\/chatgpt\.com\/c\/[^/?#]+$/, (route) => route.fulfill({ status: 200, contentType: "text/html", body: fixtureHtml() }));
    await context.route("https://chatgpt.com/api/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ accessToken: "stall-e2e-token" }) }));
    await context.route(/https:\/\/chatgpt\.com\/backend-api\/conversation\/[^/]+\/stream_status$/, async (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.match(/\/conversation\/([^/]+)\/stream_status$/)[1]);
      const count = (statusCounts.get(id) || 0) + 1;
      statusCounts.set(id, count);
      if (id === "reload-stopped-stale") {
        await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
        return;
      }
      let streaming;
      if (["pre-output-reload", "shell-loading-reload", "reload-pro", "reload-send-not-ready"].includes(id)) streaming = false;
      else if (id === "reload-running") streaming = count === 1;
      else if (id === "reload-loop") streaming = true;
      else if (id === "system-delay-banner") streaming = false;
      else streaming = count <= 2;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: streaming ? "IS_STREAMING" : "NOT_STREAMING" }) });
    });

    const worker = await waitForWorker(context);
    await configure(worker);

    for (const id of ["basic", "tool-fixed", "controlled-editor", "stale-stop"]) {
      const page = await openCase(context, id);
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 6000 });
      const s = await state(page);
      assert.equal(s.stopClicks, 1, `${id}: expected exactly one automatic Stop`);
      assert.equal(s.sentText, ".", `${id}: expected exact continuation nudge`);
      assert((statusCounts.get(id) || 0) >= 3, `${id}: expected two stall confirmations plus Stop settlement confirmation`);
      if (id === "controlled-editor") assert(s.trustedInputEvents >= 1, "controlled editor must receive a browser-native editing event");
      await page.close();
    }

    {
      const page = await openCase(context, "slow-stop");
      await page.waitForFunction(() => window.__state.stopClicks === 1, null, { timeout: 4000 });
      await page.waitForFunction(() => (document.querySelector('#cg-conversation-guard-status')?.textContent || '').includes('stopping'), null, { timeout: 1500 });
      await page.waitForTimeout(350);
      let s = await state(page);
      assert.equal(s.sends, 0); assert.equal(s.draft, "");
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 5000 });
      s = await state(page); assert.equal(s.sentText, ".");
      await page.close();
    }

    {
      const page = await openCase(context, "system-delay-banner");
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 3500 });
      assert.equal((await state(page)).sentText, ".");
      await page.close();
    }

    {
      const page = await openCase(context, "draft-protection");
      await page.waitForTimeout(700);
      const s = await state(page);
      assert.equal(s.stopClicks, 0); assert.equal(s.sends, 0); assert.equal(s.draft, "do not overwrite me");
      await page.close();
    }

    for (const id of ["pre-output-reload", "shell-loading-reload", "reload-stopped-stale"]) {
      const page = await openCase(context, id);
      await page.waitForFunction(() => window.__state.loads >= 2, null, { timeout: 5000 });
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 6000 });
      const s = await state(page);
      assert.equal(s.loads, 2, `${id}: exactly one guarded reload expected`);
      assert.equal(s.sentText, ".", `${id}: stopped page after reload must resume directly`);
      await page.close();
    }

    {
      const page = await openCase(context, "reload-running");
      await page.waitForFunction(() => window.__state.loads >= 2, null, { timeout: 5000 });
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 6000 });
      const s = await state(page);
      assert.equal(s.loads, 2); assert.equal(s.stopClicks, 1); assert.equal(s.sentText, ".");
      await page.close();
    }

    {
      const page = await openCase(context, "reload-pro");
      await page.waitForFunction(() => window.__state.loads >= 2, null, { timeout: 5000 });
      await page.waitForTimeout(1200);
      const s = await state(page);
      assert.equal(s.loads, 2); assert.equal(s.sends, 0, "Pro after reload must never receive a synthetic nudge");
      await page.close();
    }

    {
      const page = await openCase(context, "reload-loop");
      await page.waitForFunction(() => window.__state.loads >= 2, null, { timeout: 5000 });
      await page.waitForTimeout(3800);
      const s = await state(page);
      assert.equal(s.loads, 2, "failed post-reload recovery must never earn a second reload");
      assert.equal(s.sends, 0);
      await page.close();
    }

    console.log("Chromium stall-recovery 0.7.6 E2E: PASS", JSON.stringify(Object.fromEntries(statusCounts)));
  } finally {
    await context.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error && error.stack || error); process.exit(1); });
