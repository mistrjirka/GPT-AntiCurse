"use strict";

const assert = require("assert");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { Builder } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");

const ROOT = path.resolve(__dirname, "..");

function fixtureHtml() {
  return String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>AntiCurse Firefox stall recovery E2E</title></head>
<body>
<div id="main"><div id="turn-list"></div></div>
<form data-type="unified-composer">
  <div id="prompt-textarea" contenteditable="true"></div>
  <button id="composer-submit-button" type="button"></button>
</form>
<script>
(() => {
  const id = location.pathname.split('/').pop();
  const loadKey = 'stall-firefox-loads:' + id;
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

function createCertificate(dir) {
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1",
    "-subj", "/CN=chatgpt.com", "-addext", "subjectAltName=DNS:chatgpt.com"
  ], { stdio: "ignore" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function createServer(tls, statusCounts) {
  return https.createServer(tls, (req, res) => {
    const url = new URL(req.url, "https://chatgpt.com:8443");
    if (/^\/c\/[^/]+$/.test(url.pathname)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fixtureHtml());
      return;
    }
    if (url.pathname === "/api/auth/session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accessToken: "stall-firefox-token" }));
      return;
    }
    const match = url.pathname.match(/^\/backend-api\/conversation\/([^/]+)\/stream_status$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      assert.equal(req.headers.authorization || "", "Bearer stall-firefox-token");
      const count = (statusCounts.get(id) || 0) + 1;
      statusCounts.set(id, count);
      const status = id === "backend-fail-open" || count > 2 ? "NOT_STREAMING" : "IS_STREAMING";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
}

async function waitFor(driver, script, timeout = 5000) {
  await driver.wait(async () => {
    try { return !!(await driver.executeScript(script)); } catch { return false; }
  }, timeout);
}

async function state(driver) {
  return driver.executeScript("return {...window.__state, draft: document.querySelector('#prompt-textarea')?.textContent || ''}");
}

async function openCase(driver, id) {
  await driver.get(`https://chatgpt.com:8443/c/${id}`);
  await waitFor(driver, "return !!window.__state");
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "anticurse-stall-firefox-e2e-"));
  const extensionDir = path.join(temp, "firefox");
  const xpi = path.join(temp, "gpt-anticurse-firefox.xpi");
  fs.cpSync(path.join(ROOT, "firefox"), extensionDir, { recursive: true });

  const watchdogPath = path.join(extensionDir, "stall-recovery.js");
  let watchdog = fs.readFileSync(watchdogPath, "utf8");
  watchdog = watchdog
    .replace("stallRecoveryTimeoutSeconds: 120", "stallRecoveryTimeoutSeconds: 0.20")
    .replace("stallRecoveryToolTimeoutSeconds: 300", "stallRecoveryToolTimeoutSeconds: 0.55")
    .replace("stallRecoveryGraceSeconds: 10", "stallRecoveryGraceSeconds: 0.06")
    .replace("clampSeconds(next.stallRecoveryTimeoutSeconds, settings.stallRecoveryTimeoutSeconds, 60, 1800)", "clampSeconds(next.stallRecoveryTimeoutSeconds, settings.stallRecoveryTimeoutSeconds, 0.05, 1800)")
    .replace("clampSeconds(next.stallRecoveryToolTimeoutSeconds, settings.stallRecoveryToolTimeoutSeconds, 120, 3600)", "clampSeconds(next.stallRecoveryToolTimeoutSeconds, settings.stallRecoveryToolTimeoutSeconds, 0.10, 3600)");
  fs.writeFileSync(watchdogPath, watchdog);
  execFileSync("zip", ["-qr", xpi, "."], { cwd: extensionDir });

  const statusCounts = new Map();
  const server = createServer(createCertificate(temp), statusCounts);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(8443, "0.0.0.0", resolve);
  });

  const options = new firefox.Options()
    .addArguments("-headless")
    .setAcceptInsecureCerts(true)
    .setPreference("browser.cache.disk.enable", false)
    .setPreference("browser.cache.memory.enable", false)
    .setPreference("network.dns.localDomains", "chatgpt.com");
  if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);

  const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
  try {
    const addonId = await driver.installAddon(xpi, true);
    assert(addonId, "temporary Firefox watchdog addon should install");

    await openCase(driver, "basic");
    await waitFor(driver, "return window.__state.sends === 1");
    let current = await state(driver);
    assert.equal(current.stopClicks, 1);
    assert.equal(current.sentText, ".");
    assert((statusCounts.get("basic") || 0) >= 2, "Firefox recovery must confirm backend streaming twice");
    await driver.sleep(450);
    assert.equal((await state(driver)).sends, 1, "Firefox recovery must not loop on the same turn");

    await openCase(driver, "draft-protection");
    await driver.sleep(700);
    current = await state(driver);
    assert.equal(current.stopClicks, 0);
    assert.equal(current.sends, 0);
    assert.equal(current.draft, "do not overwrite me");
    assert.equal(statusCounts.get("draft-protection") || 0, 0);

    await openCase(driver, "backend-fail-open");
    await driver.sleep(700);
    current = await state(driver);
    assert.equal(current.stopClicks, 0);
    assert.equal(current.sends, 0);
    assert((statusCounts.get("backend-fail-open") || 0) >= 1);

    await openCase(driver, "activity-reset");
    await driver.sleep(120);
    assert.equal(await driver.executeScript("return window.__bumpActivity()"), true);
    await driver.sleep(140);
    assert.equal((await state(driver)).sends, 0, "Firefox active-turn progress must reset the deadline");
    await waitFor(driver, "return window.__state.sends === 1", 4000);

    await openCase(driver, "tool-timeout");
    await driver.sleep(330);
    assert.equal((await state(driver)).sends, 0, "Firefox active tool must use the longer timeout");
    assert.equal(statusCounts.get("tool-timeout") || 0, 0);
    await waitFor(driver, "return window.__state.sends === 1", 4000);

    await openCase(driver, "reload-resume");
    await waitFor(driver, "return Number(sessionStorage.getItem('stall-firefox-loads:reload-resume') || 0) >= 2", 6000);
    await waitFor(driver, "return window.__state && window.__state.sends === 1", 6000);
    current = await state(driver);
    assert.equal(current.loads, 2, "Firefox wedged composer recovery may reload at most once");
    assert.equal(current.sentText, ".");
    await driver.sleep(450);
    assert.equal(Number(await driver.executeScript("return sessionStorage.getItem('stall-firefox-loads:reload-resume')")), 2);

    console.log("Firefox stall-recovery E2E: PASS", JSON.stringify({ addonId, statusCounts: Object.fromEntries(statusCounts) }));
  } finally {
    await driver.quit().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
