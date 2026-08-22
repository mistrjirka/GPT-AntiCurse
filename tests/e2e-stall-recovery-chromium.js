"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");

function fixtureHtml() {
  return String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>AntiCurse stall recovery E2E</title></head>
<body>
<div id="main"><div id="turn-list"></div></div>
<form data-type="unified-composer">
  <div id="prompt-textarea" contenteditable="true"></div>
  <button id="composer-submit-button" type="button"></button>
</form>
<script>
(() => {
  const id = location.pathname.split('/').pop();
  const loadKey = 'stall-fixture-loads:' + id;
  const loads = Number(sessionStorage.getItem(loadKey) || 0) + 1;
  sessionStorage.setItem(loadKey, String(loads));
  const list = document.getElementById('turn-list');
  const composer = document.getElementById('prompt-textarea');
  const button = document.getElementById('composer-submit-button');
  window.__state = { id, loads, stopClicks: 0, sends: 0, sentText: '', bumps: 0 };

  function makeTurn(index, tool) {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-turn-id-container', 'turn-' + index);
    const section = document.createElement('section');
    section.setAttribute('data-testid', 'conversation-turn-' + index);
    section.setAttribute('data-turn-id', 'turn-' + index);
    const streaming = document.createElement('div');
    streaming.setAttribute('data-streaming-response-status', 'streaming');
    streaming.textContent = 'assistant output ' + index;
    if (tool) {
      const row = document.createElement('div');
      row.className = 'tool-row';
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

  let active = null;
  function setSubmit(disabled = false) {
    button.setAttribute('data-testid', 'send-button');
    button.textContent = 'Send';
    button.disabled = disabled;
    if (active && active.streaming) active.streaming.removeAttribute('data-streaming-response-status');
  }
  function setStop() {
    button.setAttribute('data-testid', 'stop-button');
    button.textContent = 'Stop';
    button.disabled = false;
  }

  const resumeLoad = id === 'reload-resume' && loads > 1;
  if (!resumeLoad) {
    active = makeTurn(1, id === 'tool-timeout');
    setStop();
  } else {
    setSubmit(false);
  }

  if (id === 'system-delay-banner' && active?.streaming) {
    const banner = document.createElement('span');
    banner.className = 'loading-shimmer-tertiary';
    banner.append('Our systems are thinking a bit more about this request before responding. You can retry with a faster model for a quicker response, though it may be less capable of handling complex requests. ');
    const learnMore = document.createElement('a');
    learnMore.href = 'https://help.openai.com/articles/20001326';
    learnMore.textContent = 'Learn more';
    banner.append(learnMore);
    active.streaming.append(banner);
  }
  if (id === 'draft-protection') composer.textContent = 'do not overwrite me';

  button.addEventListener('click', () => {
    if (button.getAttribute('data-testid') === 'stop-button') {
      window.__state.stopClicks++;
      if (id === 'reload-resume') setSubmit(true);
      else setSubmit(false);
      return;
    }
    if (button.disabled) return;
    const text = (composer.textContent || '').trim();
    window.__state.sends++;
    window.__state.sentText = text;
    composer.replaceChildren();
    active = makeTurn(2 + window.__state.sends, false);
    setStop();
  });

  window.__bumpActivity = () => {
    if (!active || !active.streaming) return false;
    const span = document.createElement('span');
    span.textContent = ' progress-' + (++window.__state.bumps);
    active.streaming.append(span);
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
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const ready = await worker.evaluate(() => !!(globalThis.chrome && chrome.storage && chrome.storage.local)).catch(() => false);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Chromium extension storage API did not become ready");
}

async function configure(worker, enabled = true) {
  await waitForStorageApi(worker);
  await worker.evaluate(async ({ enabled }) => {
    await chrome.storage.local.set({
      enabled: false,
      showGuardNotice: false,
      stallRecoveryEnabled: enabled,
      stallRecoveryTimeoutSeconds: 0.20,
      stallRecoveryToolTimeoutSeconds: 0.55,
      stallRecoveryGraceSeconds: 0.06
    });
  }, { enabled });
}

async function setPerformance(worker, enabled) {
  await waitForStorageApi(worker);
  await worker.evaluate(async ({ enabled }) => chrome.storage.local.set({ enabled }), { enabled });
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

  // Only the E2E copy shortens the production timer clamps. The exact packaged
  // source is separately syntax/static-tested with 120s / 300s / 10s defaults.
  const watchdogPath = path.join(extensionPath, "stall-recovery.js");
  let watchdog = fs.readFileSync(watchdogPath, "utf8");
  watchdog = watchdog
    .replace("clampSeconds(next.stallRecoveryTimeoutSeconds, settings.stallRecoveryTimeoutSeconds, 60, 1800)", "clampSeconds(next.stallRecoveryTimeoutSeconds, settings.stallRecoveryTimeoutSeconds, 0.05, 1800)")
    .replace("clampSeconds(next.stallRecoveryToolTimeoutSeconds, settings.stallRecoveryToolTimeoutSeconds, 120, 3600)", "clampSeconds(next.stallRecoveryToolTimeoutSeconds, settings.stallRecoveryToolTimeoutSeconds, 0.10, 3600)");
  fs.writeFileSync(watchdogPath, watchdog);

  const statusCounts = new Map();
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });

  try {
    await context.route(/https:\/\/chatgpt\.com\/c\/[^/?#]+$/, (route) => route.fulfill({ status: 200, contentType: "text/html", body: fixtureHtml() }));
    await context.route("https://chatgpt.com/api/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ accessToken: "stall-e2e-token" }) }));
    await context.route(/https:\/\/chatgpt\.com\/backend-api\/conversation\/[^/]+\/stream_status$/, async (route) => {
      const match = new URL(route.request().url()).pathname.match(/\/conversation\/([^/]+)\/stream_status$/);
      const id = decodeURIComponent(match[1]);
      const count = (statusCounts.get(id) || 0) + 1;
      statusCounts.set(id, count);
      const status = id === "backend-fail-open" || id === "system-delay-banner" || count > 2 ? "NOT_STREAMING" : "IS_STREAMING";
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status }) });
    });

    const worker = await waitForWorker(context);
    await configure(worker, true);

    {
      const page = await openCase(context, "basic");
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 4000 });
      const s = await state(page);
      assert.equal(s.stopClicks, 1);
      assert.equal(s.sentText, ".");
      assert(statusCounts.get("basic") >= 2, "basic recovery must confirm backend streaming twice");
      await page.waitForTimeout(450);
      assert.equal((await state(page)).sends, 1, "same recovered run must not loop");
      await page.close();
    }

    {
      const page = await openCase(context, "system-delay-banner");
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 2000 });
      const s = await state(page);
      assert.equal(s.stopClicks, 1, "explicit long-wait banner must trigger auto-resume");
      assert.equal(s.sentText, ".");
      // The fixture returns NOT_STREAMING for this conversation. A successful
      // Stop -> dot -> Send therefore proves the banner path did not require
      // backend confirmation; a later query may belong to the new recovered turn.
      await page.close();
    }

    {
      const page = await openCase(context, "draft-protection");
      await page.waitForTimeout(700);
      const s = await state(page);
      assert.equal(s.stopClicks, 0);
      assert.equal(s.sends, 0);
      assert.equal(s.draft, "do not overwrite me");
      assert.equal(statusCounts.get("draft-protection") || 0, 0, "draft protection should fail closed before backend intervention checks");
      await page.close();
    }

    {
      const page = await openCase(context, "backend-fail-open");
      await page.waitForTimeout(700);
      const s = await state(page);
      assert.equal(s.stopClicks, 0);
      assert.equal(s.sends, 0);
      assert((statusCounts.get("backend-fail-open") || 0) >= 1);
      await page.close();
    }

    {
      const page = await openCase(context, "activity-reset");
      await page.waitForTimeout(120);
      assert.equal(await page.evaluate(() => window.__bumpActivity()), true);
      await page.waitForTimeout(140);
      assert.equal((await state(page)).sends, 0, "meaningful active-turn mutation must restart the stall deadline");
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 3000 });
      await page.close();
    }

    {
      await setPerformance(worker, true);
      const page = await openCase(context, "tool-timeout");
      const shimmer = await page.evaluate(() => {
        const node = document.querySelector(".loading-shimmer-tertiary");
        const style = node && getComputedStyle(node);
        return { text: node?.textContent || "", animationName: style?.animationName || "" };
      });
      assert.equal(shimmer.text, "Working", "disabling the cosmetic shimmer must preserve readable tool status text");
      assert.equal(shimmer.animationName, "none", "performance mode must stop only the non-composited loading shimmer");
      await page.waitForTimeout(330);
      assert.equal((await state(page)).sends, 0, "active tools must use the longer timeout");
      assert.equal(statusCounts.get("tool-timeout") || 0, 0, "backend should not be queried at the normal non-tool threshold");
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 3000 });
      await page.close();
      await setPerformance(worker, false);
    }

    {
      await configure(worker, false);
      const page = await openCase(context, "disabled");
      await page.waitForTimeout(700);
      const s = await state(page);
      assert.equal(s.stopClicks, 0);
      assert.equal(s.sends, 0);
      assert.equal(statusCounts.get("disabled") || 0, 0);
      await page.close();
      await configure(worker, true);
    }

    {
      const page = await openCase(context, "reload-resume");
      await page.waitForFunction(() => Number(sessionStorage.getItem('stall-fixture-loads:reload-resume') || 0) >= 2, null, { timeout: 5000 });
      await page.waitForFunction(() => window.__state && window.__state.sends === 1, null, { timeout: 5000 });
      const s = await state(page);
      assert.equal(s.loads, 2, "wedged composer recovery may reload at most once");
      assert.equal(s.sentText, ".");
      assert.equal(Number(await page.evaluate(() => sessionStorage.getItem('stall-fixture-loads:reload-resume'))), 2);
      await page.waitForTimeout(450);
      assert.equal(Number(await page.evaluate(() => sessionStorage.getItem('stall-fixture-loads:reload-resume'))), 2, "resume must never enter a reload loop");
      await page.close();
    }

    console.log("Chromium stall-recovery E2E: PASS", JSON.stringify(Object.fromEntries(statusCounts)));
  } finally {
    await context.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
