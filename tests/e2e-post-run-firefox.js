"use strict";

const assert = require("assert");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { Builder, By } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");

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

function createCertificate(dir) {
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=chatgpt.com", "-addext", "subjectAltName=DNS:chatgpt.com"], { stdio: "ignore" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function createServer(tls) {
  return https.createServer(tls, (req, res) => {
    const url = new URL(req.url, "https://chatgpt.com:8443");
    const chat = url.pathname.match(/^\/c\/([^/]+)$/);
    if (chat) {
      const id = decodeURIComponent(chat[1]);
      const n = (loadCounts.get(id) || 0) + 1;
      loadCounts.set(id, n);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(fixtureHtml(id, n));
      return;
    }
    if (url.pathname === "/api/auth/session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accessToken: "post-run-firefox-token" }));
      return;
    }
    const status = url.pathname.match(/^\/backend-api\/conversation\/([^/]+)\/stream_status$/);
    if (status) {
      assert.equal(req.headers.authorization || "", "Bearer post-run-firefox-token");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "NOT_STREAMING" }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
}

async function waitFor(driver, script, timeout = 6000) {
  await driver.wait(async () => {
    try { return !!(await driver.executeScript(script)); } catch { return false; }
  }, timeout);
}

async function openCase(driver, id) {
  await driver.get(`https://chatgpt.com:8443/c/${id}`);
  await waitFor(driver, "return !!window.__state");
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "anticurse-post-run-firefox-"));
  const extensionDir = path.join(temp, "firefox");
  const xpi = path.join(temp, "gpt-anticurse-firefox.xpi");
  fs.cpSync(path.join(ROOT, "firefox"), extensionDir, { recursive: true });
  execFileSync("zip", ["-qr", xpi, "."], { cwd: extensionDir });

  const server = createServer(createCertificate(temp));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(8443, "0.0.0.0", resolve); });
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
    assert(addonId);

    await openCase(driver, "tool-ended");
    await waitFor(driver, "return Number(sessionStorage.getItem('fixture-sends')||0)===1");
    let state = await driver.executeScript("return window.__state");
    assert.equal(state.stopClicks, 0, "natural tool-only terminal state must not click Stop");
    assert.equal(state.sentText, ".", "tool-only terminal state must continue with dot");
    assert.equal(loadCounts.get("tool-ended"), 1, "tool-only terminal state must not reload");

    await openCase(driver, "useful-answer");
    await driver.sleep(1400);
    assert.equal(await driver.executeScript("return Number(sessionStorage.getItem('fixture-sends')||0)"), 0, "useful Markdown answer must not auto-continue");

    await openCase(driver, "manual-stop");
    const stop = await driver.findElement(By.css('#composer-submit-button[data-testid="stop-button"]'));
    await stop.click();
    await driver.sleep(1400);
    state = await driver.executeScript("return window.__state");
    assert.equal(state.stopClicks, 1, "fixture manual Stop should remain native");
    assert.equal(state.sends, 0, "trusted/manual Stop must suppress post-run auto-continuation");

    await openCase(driver, "network-reload");
    await waitFor(driver, "return Number(sessionStorage.getItem('fixture-sends')||0)===1", 8000);
    assert((loadCounts.get("network-reload") || 0) >= 2, "retryable network error must reload before continuation");
    state = await driver.executeScript("return window.__state");
    assert.equal(state.sentText, ".", "reloaded network-error conversation must continue with dot");

    console.log("Firefox post-run recovery E2E: PASS", JSON.stringify({ addonId, loadCounts: Object.fromEntries(loadCounts) }));
  } finally {
    await driver.quit().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error && error.stack || error); process.exit(1); });
