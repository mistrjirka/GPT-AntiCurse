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
    section.setAttribute('data-turn-id-container', 'turn-' + index);
    const streaming = document.createElement('div');
    streaming.setAttribute('data-streaming-response-status', 'streaming');
    streaming.textContent = 'assistant output ' + index;
    if (tool) {
      const row = document.createElement('div');
      row.className = 'tool-row';
      const icon = document.createElement('span');
      icon.setAttribute('data-testid', 'cot-v5-tool-icon-pile');
      const inner = document.createElement('div');
      const inner2 = document.createElement('div');
      const shimmer = document.createElement('span');
      shimmer.className = 'loading-shimmer-tertiary';
      shimmer.textContent = 'Working';
      inner2.append(shimmer);
      inner.append(inner2);
      row.append(icon, inner);
      streaming.append(row);
    }
    section.append(streaming);
    wrapper.append(section);
    list.append(wrapper);
    return { wrapper, streaming };
  }

  let active = null;
  function setSubmit(disabled = false) {
    button.id = 'composer-submit-button';
    button.setAttribute('data-testid', 'send-button');
    button.textContent = 'Send';
    button.disabled = disabled;
    if (active && active.streaming) active.streaming.removeAttribute('data-streaming-response-status');
  }
  function setStop() {
    button.id = 'composer-submit-button';
    button.setAttribute('data-testid', 'stop-button');
    button.textContent = 'Stop';
    button.disabled = false;
  }
  function setVoiceOnly() {
    button.removeAttribute('id');
    button.removeAttribute('data-testid');
    button.setAttribute('aria-label', 'Start Voice');
    button.textContent = 'Voice';
    button.disabled = false;
  }

  if (id === 'late-run-after-idle') {
    setSubmit(false);
  } else active = makeTurn(1, id === 'tool-timeout' || id === 'detached-tool-no-stop');
  if (id === 'late-streaming-marker' && active) active.streaming.removeAttribute('data-streaming-response-status');
  if (active) {
    if (id === 'detached-no-stop' || id === 'detached-tool-no-stop' || id === 'backend-stop-no-button') setVoiceOnly();
    else setStop();
  }
  if (id === 'late-streaming-marker' && active) {
    setTimeout(() => active.streaming.setAttribute('data-streaming-response-status', 'streaming'), 60);
  }
  if (id === 'same-turn-remount' && active) {
    setTimeout(() => {
      const replacement = active.wrapper.cloneNode(true);
      active.wrapper.replaceWith(replacement);
      active = { wrapper: replacement, streaming: replacement.querySelector('[data-streaming-response-status]') };
    }, 120);
  }
  if (id === 'disabled-until-input') {
    new MutationObserver(() => {
      if ((composer.textContent || '').trim()) button.disabled = false;
    }).observe(composer, { childList: true, subtree: true, characterData: true });
  }
  if (id === 'detached-no-stop' || id === 'detached-tool-no-stop' || id === 'backend-stop-no-button') {
    new MutationObserver(() => {
      if ((composer.textContent || '').trim()) setSubmit(false);
    }).observe(composer, { childList: true, subtree: true, characterData: true });
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
    if (id === 'late-run-after-idle' && !active) {
      window.__state.userStarts = (window.__state.userStarts || 0) + 1;
      setTimeout(() => { active = makeTurn(1, false); setStop(); }, 50);
      return;
    }
    if (button.getAttribute('data-testid') === 'stop-button') {
      window.__state.stopClicks++;
      if (id === 'disabled-until-input') setSubmit(true);
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
      showGuardNotice: true,
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
  const hookName = "stall-background-test-hook.js";
  fs.writeFileSync(path.join(extensionPath, hookName), `
    if (location.pathname.endsWith('/background-hidden')) {
      try { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); } catch {}
      globalThis.requestAnimationFrame = () => 1;
    }
  `);
  const manifestPath = path.join(extensionPath, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const isolated = manifest.content_scripts.find((entry) => (entry.js || []).includes("stall-recovery.js"));
  isolated.js.splice(isolated.js.indexOf("stall-recovery.js"), 0, hookName);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Only the E2E copy shortens the production timer clamps. The exact packaged
  // source is separately syntax/static-tested with 120s / 300s / 10s defaults.
  const watchdogPath = path.join(extensionPath, "stall-recovery.js");
  let watchdog = fs.readFileSync(watchdogPath, "utf8");
  watchdog = watchdog
    .replace("clampSeconds(next.stallRecoveryTimeoutSeconds, settings.stallRecoveryTimeoutSeconds, 60, 1800)", "clampSeconds(next.stallRecoveryTimeoutSeconds, settings.stallRecoveryTimeoutSeconds, 0.05, 1800)")
    .replace("clampSeconds(next.stallRecoveryToolTimeoutSeconds, settings.stallRecoveryToolTimeoutSeconds, 120, 3600)", "clampSeconds(next.stallRecoveryToolTimeoutSeconds, settings.stallRecoveryToolTimeoutSeconds, 0.10, 3600)")
    .replace("discoveryTimer = setTimeout(clearDiscovery, 10_000)", "discoveryTimer = setTimeout(clearDiscovery, 300)");
  fs.writeFileSync(watchdogPath, watchdog);

  const statusCounts = new Map();
  const interruptCounts = new Map();
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
      const detached = id === "detached-no-stop" || id === "detached-tool-no-stop";
      const status = detached || id === "backend-fail-open" || id === "system-delay-banner" || count > 2 ? "NOT_STREAMING" : "IS_STREAMING";
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status }) });
    });
    await context.route("https://chatgpt.com/backend-api/stop_conversation", async (route) => {
      const body = route.request().postDataJSON();
      const id = body && body.conversation_id;
      interruptCounts.set(id, (interruptCounts.get(id) || 0) + 1);
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
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
      const page = await openCase(context, "late-run-after-idle");
      await page.waitForTimeout(450);
      await page.click('#composer-submit-button');
      assert.equal(await page.evaluate(() => window.__state.userStarts), 1, "fixture must launch the run through the Send click");
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 3000, polling: 25 });
      assert.equal((await state(page)).sentText, ".", "run started after discovery expiry must still be recovered");
      await page.close();
    }

    {
      const page = await openCase(context, "late-streaming-marker");
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 3000, polling: 25 });
      assert.equal((await state(page)).sentText, ".", "late streaming marker must still start the watchdog");
      await page.close();
    }

    {
      const page = await openCase(context, "detached-no-stop");
      await page.waitForFunction(() => (document.querySelector('#cg-conversation-guard-status')?.textContent || '').includes('auto-continue in'), null, { timeout: 1500 });
      assert.equal(await page.locator('[data-testid="stop-button"]').count(), 0, "live detached fixture must have no Stop button");
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 3500, polling: 20 });
      const s = await state(page);
      assert.equal(s.stopClicks, 0, "stale non-streaming backend should not need a Stop click");
      assert.equal(s.sentText, ".");
      assert.equal(interruptCounts.get("detached-no-stop") || 0, 0, "already-stopped backend must not receive an interrupt POST");
      await page.close();
    }

    {
      const page = await openCase(context, "backend-stop-no-button");
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 3500, polling: 20 });
      assert.equal(interruptCounts.get("backend-stop-no-button") || 0, 1, "live backend with missing Stop control must use /stop_conversation once");
      assert.equal((await state(page)).sentText, ".");
      await page.close();
    }

    {
      const page = await openCase(context, "detached-tool-no-stop");
      await page.waitForFunction(() => (document.querySelector('#cg-conversation-guard-status')?.textContent || '').includes('tool auto-continue in'), null, { timeout: 1500 });
      await page.waitForTimeout(320);
      assert.equal((await state(page)).sends, 0, "live-style tool stall must retain the longer tool deadline even with no Stop button");
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 3500, polling: 20 });
      await page.close();
    }

    {
      const page = await openCase(context, "background-hidden");
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 4000, polling: 25 });
      const s = await state(page);
      assert.equal(s.stopClicks, 1, "hidden-tab emulation must still click Stop");
      assert.equal(s.sentText, ".", "hidden-tab emulation must still send the nudge");
      await page.close();
    }

    {
      const page = await openCase(context, "same-turn-remount");
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 3000, polling: 20 });
      assert.equal((await state(page)).sentText, ".", "same logical turn remount must preserve a recoverable watchdog");
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
      const page = await openCase(context, "disabled-until-input");
      await page.waitForFunction(() => window.__state && window.__state.sends === 1, null, { timeout: 5000 });
      const s = await state(page);
      assert.equal(s.loads, 1, "recovery must not reload when Send starts disabled");
      assert.equal(s.stopClicks, 1);
      assert.equal(s.sentText, ".");
      await page.waitForTimeout(450);
      assert.equal(Number(await page.evaluate(() => sessionStorage.getItem('stall-fixture-loads:disabled-until-input'))), 1);
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
