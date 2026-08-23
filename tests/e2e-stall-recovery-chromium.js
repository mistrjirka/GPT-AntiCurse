"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");

function fixtureHtml() {
  return String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>AntiCurse recovery E2E</title></head>
<body>
<div id="main"><div id="turn-list"></div></div>
<form data-type="unified-composer">
  <div id="prompt-textarea" contenteditable="true"></div>
  <button id="composer-submit-button" type="button"></button>
</form>
<script>
(() => {
  const id = location.pathname.split('/').pop();
  const list = document.getElementById('turn-list');
  const composer = document.getElementById('prompt-textarea');
  const button = document.getElementById('composer-submit-button');
  window.__state = { id, stopClicks: 0, sends: 0, sentText: '', stopAt: 0, sendAt: 0, staleMarkersAtStop: 0 };

  function makeTurn(index, { tool = false, output = true, key = null } = {}) {
    const turnKey = key || ('turn-' + index);
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-turn-id-container', turnKey);
    const section = document.createElement('section');
    section.setAttribute('data-testid', 'conversation-turn-' + index);
    section.setAttribute('data-turn-id', turnKey);
    section.setAttribute('data-turn', 'assistant');
    const message = document.createElement('div');
    message.setAttribute('data-message-author-role', 'assistant');
    message.setAttribute('data-message-model-slug', 'gpt-5-6-thinking');
    if (output) message.textContent = 'assistant output ' + index;
    section.append(message);
    const streaming = document.createElement('div');
    streaming.setAttribute('data-streaming-response-status', 'streaming');
    if (tool) {
      const row = document.createElement('div');
      const icon = document.createElement('span');
      icon.setAttribute('data-testid', 'cot-v5-tool-icon-pile');
      const shimmer = document.createElement('span');
      shimmer.className = 'loading-shimmer-tertiary';
      shimmer.textContent = 'Working';
      row.append(icon, shimmer);
      streaming.append(row);
    }
    section.append(streaming);
    wrapper.append(section);
    list.append(wrapper);
    return { wrapper, streaming };
  }

  let active = makeTurn(1, { tool: id === 'tool-fixed', output: id !== 'pre-output-loading' });

  function setStop() {
    button.setAttribute('data-testid', 'stop-button');
    button.textContent = 'Stop';
    button.disabled = false;
  }
  function setSend(disabled = false, settle = true) {
    button.setAttribute('data-testid', 'send-button');
    button.textContent = 'Send';
    button.disabled = disabled;
    if (settle && active?.streaming) active.streaming.removeAttribute('data-streaming-response-status');
  }
  setStop();

  if (id === 'system-delay-banner') {
    const banner = document.createElement('span');
    banner.className = 'loading-shimmer-tertiary';
    banner.append('Our systems are thinking a bit more about this request before responding. ');
    const a = document.createElement('a');
    a.href = 'https://help.openai.com/articles/20001326';
    a.textContent = 'Learn more';
    banner.append(a);
    active.streaming.append(banner);
  }
  if (id === 'draft-protection') composer.textContent = 'do not overwrite me';

  button.addEventListener('click', () => {
    if (button.getAttribute('data-testid') === 'stop-button') {
      window.__state.stopClicks++;
      window.__state.stopAt = performance.now();
      if (id === 'slow-stop') {
        // Model the real ChatGPT limbo: Stop control disappears quickly, but
        // the old assistant turn remains streaming while cancellation unwinds.
        setSend(true, false);
        setTimeout(() => {
          active.streaming.removeAttribute('data-streaming-response-status');
          button.disabled = false;
        }, 650);
      } else if (id === 'stale-stopped-dom') {
        // Captured live failure: ChatGPT has already stopped and remounted the
        // newest assistant request as idle, while an older copy still retains a
        // stale data-streaming-response-status marker. v0.7.5 stayed "stopping".
        setSend(false, false);
        const stoppedCopy = makeTurn(99, { output: false, key: 'turn-1' });
        stoppedCopy.streaming.removeAttribute('data-streaming-response-status');
        window.__state.staleMarkersAtStop = document.querySelectorAll('[data-streaming-response-status]').length;
      } else {
        setSend(id === 'disabled-until-input', true);
      }
      return;
    }
    if (button.disabled) return;
    const text = (composer.textContent || '').trim();
    window.__state.sends++;
    window.__state.sentText = text;
    window.__state.sendAt = performance.now();
    composer.replaceChildren();
    active = makeTurn(2 + window.__state.sends);
    setStop();
  });

  if (id === 'disabled-until-input') {
    new MutationObserver(() => {
      if ((composer.textContent || '').trim() && button.getAttribute('data-testid') !== 'stop-button') button.disabled = false;
    }).observe(composer, { childList: true, subtree: true, characterData: true });
  }
  window.__revealAssistantOutput = () => {
    const msg = active.wrapper.querySelector('[data-message-author-role="assistant"]');
    if (!msg || msg.textContent) return false;
    msg.textContent = 'first actual assistant output';
    return true;
  };
})();
</script>
</body></html>`;
}

function isAntiCurseWorker(worker) {
  return /^chrome-extension:\/\//.test(worker.url()) && /\/background-entry\.js(?:$|[?#])/.test(worker.url());
}
async function waitForWorker(context) {
  return context.serviceWorkers().find(isAntiCurseWorker) || context.waitForEvent("serviceworker", isAntiCurseWorker);
}
async function waitForStorageApi(worker) {
  await worker.waitForFunction?.(() => !!(globalThis.chrome && chrome.storage && chrome.storage.local)).catch(() => {});
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await worker.evaluate(() => !!(globalThis.chrome && chrome.storage && chrome.storage.local)).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Chromium extension storage API did not become ready");
}
async function configure(worker, enabled = true) {
  await waitForStorageApi(worker);
  await worker.evaluate(async ({ enabled }) => chrome.storage.local.set({
    enabled: false,
    showGuardNotice: true,
    stallRecoveryEnabled: enabled
  }), { enabled });
}
async function openCase(context, id) {
  const page = await context.newPage();
  await page.goto(`https://chatgpt.com/c/${id}`, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__state);
  return page;
}
async function state(page) {
  return page.evaluate(() => ({ ...window.__state, draft: document.querySelector('#prompt-textarea')?.textContent || '' }));
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
    .replace("const STOP_SETTLE_TIMEOUT_MS = 180_000;", "const STOP_SETTLE_TIMEOUT_MS = 1_500;")
    .replace("const SEND_READY_TIMEOUT_MS = 180_000;", "const SEND_READY_TIMEOUT_MS = 1_500;")
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
      statusCounts.set(id, (statusCounts.get(id) || 0) + 1);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "IS_STREAMING" }) });
    });
    const worker = await waitForWorker(context);
    await configure(worker, true);

    for (const id of ["basic", "tool-fixed", "disabled-until-input"]) {
      const page = await openCase(context, id);
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 5000 });
      const s = await state(page);
      assert.equal(s.stopClicks, 1, `${id}: expected exactly one automatic Stop`);
      assert.equal(s.sentText, ".", `${id}: expected exact continuation nudge`);
      if (id === "tool-fixed") assert((s.stopAt || 0) < 1000, "tool DOM must not select a longer stall deadline");
      if (id !== "disabled-until-input") assert((statusCounts.get(id) || 0) >= 2, `${id}: ordinary timeout must confirm streaming twice`);
      await page.close();
    }

    {
      const page = await openCase(context, "slow-stop");
      await page.waitForFunction(() => window.__state.stopClicks === 1, null, { timeout: 3000 });
      await page.waitForFunction(() => (document.querySelector('#cg-conversation-guard-status')?.textContent || '').includes('stopping'), null, { timeout: 1500 });
      await page.waitForTimeout(350);
      let s = await state(page);
      assert.equal(s.sends, 0, "must not type/send while the original turn is still cancelling");
      assert.equal(s.draft, "", "composer must remain untouched during Stop settlement");
      const recoveryUi = await page.evaluate(() => {
        const badge = document.querySelector('#cg-conversation-guard-status');
        return { phase: badge?.dataset?.recoveryPhase || null, state: badge?.querySelector('.cg-state')?.textContent || '' };
      });
      assert.equal(recoveryUi.phase, "stopping");
      assert.equal(recoveryUi.state, "stopping", "countdown must be replaced by the stopping transaction state");
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 4000 });
      s = await state(page);
      assert(s.sendAt - s.stopAt >= 600, "Send must wait for slow Stop settlement");
      await page.close();
    }

    {
      const page = await openCase(context, "stale-stopped-dom");
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 4000 });
      const s = await state(page);
      assert.equal(s.stopClicks, 1, "captured stale-DOM case must Stop exactly once");
      assert.equal(s.staleMarkersAtStop, 1, "fixture must preserve the stale historical streaming marker after Stop");
      assert.equal(s.sentText, ".", "stale historical streaming DOM must not pin recovery in stopping");
      await page.close();
    }

    {
      const page = await openCase(context, "system-delay-banner");
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 2500 });
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
    {
      const page = await openCase(context, "pre-output-loading");
      await page.waitForFunction(() => (document.querySelector('#cg-conversation-guard-status')?.textContent || '').includes('loading'));
      await page.waitForTimeout(500);
      assert.equal((await state(page)).stopClicks, 0);
      assert.equal(await page.evaluate(() => window.__revealAssistantOutput()), true);
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 4000 });
      await page.close();
    }

    console.log("Chromium stall-recovery E2E: PASS", JSON.stringify(Object.fromEntries(statusCounts)));
  } finally {
    await context.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error && error.stack || error); process.exit(1); });