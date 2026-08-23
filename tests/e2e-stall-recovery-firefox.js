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
  return String.raw`<!doctype html><html><head><meta charset="utf-8"><title>AntiCurse Firefox recovery E2E</title></head><body>
<div id="main"><div id="turn-list"></div></div>
<form data-type="unified-composer"><div id="prompt-textarea" contenteditable="true"></div><button id="composer-submit-button" type="button"></button></form>
<script>
(() => {
  const id = location.pathname.split('/').pop();
  const list = document.getElementById('turn-list');
  const composer = document.getElementById('prompt-textarea');
  const button = document.getElementById('composer-submit-button');
  window.__state = { id, stopClicks: 0, sends: 0, sentText: '', stopAt: 0, sendAt: 0, staleMarkersAtStop: 0 };
  function makeTurn(index, { tool = false, output = true, key = null } = {}) {
    const turnKey = key || ('turn-' + index);
    const wrapper = document.createElement('div'); wrapper.setAttribute('data-turn-id-container', turnKey);
    const section = document.createElement('section'); section.setAttribute('data-testid', 'conversation-turn-' + index); section.setAttribute('data-turn-id', turnKey); section.setAttribute('data-turn', 'assistant');
    const message = document.createElement('div'); message.setAttribute('data-message-author-role', 'assistant'); message.setAttribute('data-message-model-slug', 'gpt-5-6-thinking'); if (output) message.textContent = 'assistant output ' + index; section.append(message);
    const streaming = document.createElement('div'); streaming.setAttribute('data-streaming-response-status', 'streaming');
    if (tool) { const row = document.createElement('div'); const icon = document.createElement('span'); icon.setAttribute('data-testid','cot-v5-tool-icon-pile'); const shimmer = document.createElement('span'); shimmer.className='loading-shimmer-tertiary'; shimmer.textContent='Working'; row.append(icon, shimmer); streaming.append(row); }
    section.append(streaming); wrapper.append(section); list.append(wrapper); return { wrapper, streaming };
  }
  let active = makeTurn(1, { tool: id === 'tool-fixed', output: id !== 'pre-output-loading' });
  function setStop(){ button.setAttribute('data-testid','stop-button'); button.textContent='Stop'; button.disabled=false; }
  function setSend(disabled=false, settle=true){ button.setAttribute('data-testid','send-button'); button.textContent='Send'; button.disabled=disabled; if (settle && active?.streaming) active.streaming.removeAttribute('data-streaming-response-status'); }
  setStop();
  if (id === 'system-delay-banner') { const b=document.createElement('span'); b.className='loading-shimmer-tertiary'; b.append('Our systems are thinking a bit more about this request before responding. '); const a=document.createElement('a'); a.href='https://help.openai.com/articles/20001326'; a.textContent='Learn more'; b.append(a); active.streaming.append(b); }
  if (id === 'draft-protection') composer.textContent='do not overwrite me';
  button.addEventListener('click', () => {
    if (button.getAttribute('data-testid') === 'stop-button') {
      window.__state.stopClicks++; window.__state.stopAt=performance.now();
      if (id === 'slow-stop') { setSend(true, false); setTimeout(() => { active.streaming.removeAttribute('data-streaming-response-status'); button.disabled=false; }, 650); }
      else if (id === 'stale-stopped-dom') {
        // Captured live failure: the newest stopped request is idle, but an old
        // duplicate/history node still has data-streaming-response-status.
        setSend(false, false);
        const stoppedCopy=makeTurn(99,{output:false,key:'turn-1'});
        stoppedCopy.streaming.removeAttribute('data-streaming-response-status');
        window.__state.staleMarkersAtStop=document.querySelectorAll('[data-streaming-response-status]').length;
      }
      else setSend(id === 'disabled-until-input', true);
      return;
    }
    if (button.disabled) return;
    const text=(composer.textContent||'').trim(); window.__state.sends++; window.__state.sentText=text; window.__state.sendAt=performance.now(); composer.replaceChildren(); active=makeTurn(2+window.__state.sends); setStop();
  });
  if (id === 'disabled-until-input') new MutationObserver(() => { if ((composer.textContent||'').trim() && button.getAttribute('data-testid') !== 'stop-button') button.disabled=false; }).observe(composer,{childList:true,subtree:true,characterData:true});
  window.__revealAssistantOutput = () => { const msg=active.wrapper.querySelector('[data-message-author-role="assistant"]'); if (!msg || msg.textContent) return false; msg.textContent='first actual assistant output'; return true; };
})();
</script></body></html>`;
}

function createCertificate(dir) {
  const key = path.join(dir, "key.pem"), cert = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=chatgpt.com","-addext","subjectAltName=DNS:chatgpt.com"], { stdio: "ignore" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}
function createServer(tls, statusCounts) {
  return https.createServer(tls, (req, res) => {
    const url = new URL(req.url, "https://chatgpt.com:8443");
    if (/^\/c\/[^/]+$/.test(url.pathname)) { res.writeHead(200,{"content-type":"text/html; charset=utf-8"}); res.end(fixtureHtml()); return; }
    if (url.pathname === "/api/auth/session") { res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify({accessToken:"stall-firefox-token"})); return; }
    const m=url.pathname.match(/^\/backend-api\/conversation\/([^/]+)\/stream_status$/);
    if (m) { const id=decodeURIComponent(m[1]); statusCounts.set(id,(statusCounts.get(id)||0)+1); assert.equal(req.headers.authorization||"","Bearer stall-firefox-token"); res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify({status:"IS_STREAMING"})); return; }
    res.writeHead(404,{"content-type":"text/plain"}); res.end("not found");
  });
}
async function waitFor(driver, script, timeout=5000){ await driver.wait(async()=>{try{return !!(await driver.executeScript(script));}catch{return false;}},timeout); }
async function state(driver){ return driver.executeScript("return {...window.__state,draft:document.querySelector('#prompt-textarea')?.textContent||''}"); }
async function openCase(driver,id){ await driver.get(`https://chatgpt.com:8443/c/${id}`); await waitFor(driver,"return !!window.__state"); }

(async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"anticurse-stall-firefox-e2e-"));
  const extensionDir=path.join(temp,"firefox"), xpi=path.join(temp,"gpt-anticurse-firefox.xpi");
  fs.cpSync(path.join(ROOT,"firefox"),extensionDir,{recursive:true});
  const watchdogPath=path.join(extensionDir,"stall-recovery.js");
  let watchdog=fs.readFileSync(watchdogPath,"utf8");
  watchdog=watchdog
    .replace("const STALL_TIMEOUT_MS = 120_000;","const STALL_TIMEOUT_MS = 200;")
    .replace("const STOP_SETTLE_TIMEOUT_MS = 180_000;","const STOP_SETTLE_TIMEOUT_MS = 1_500;")
    .replace("const SEND_READY_TIMEOUT_MS = 180_000;","const SEND_READY_TIMEOUT_MS = 1_500;")
    .replace("const SEND_CONFIRM_TIMEOUT_MS = 30_000;","const SEND_CONFIRM_TIMEOUT_MS = 1_500;");
  fs.writeFileSync(watchdogPath,watchdog); execFileSync("zip",["-qr",xpi,"."],{cwd:extensionDir});
  const statusCounts=new Map(); const server=createServer(createCertificate(temp),statusCounts);
  await new Promise((resolve,reject)=>{server.once("error",reject); server.listen(8443,"0.0.0.0",resolve);});
  const options=new firefox.Options().addArguments("-headless").setAcceptInsecureCerts(true).setPreference("browser.cache.disk.enable",false).setPreference("browser.cache.memory.enable",false).setPreference("network.dns.localDomains","chatgpt.com");
  if(process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
  const driver=await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
  try {
    const addonId=await driver.installAddon(xpi,true); assert(addonId);
    for (const id of ["basic","tool-fixed","disabled-until-input"]) {
      await openCase(driver,id); await waitFor(driver,"return window.__state.sends===1",6000); const s=await state(driver);
      assert.equal(s.stopClicks,1,`${id}: expected one Stop`); assert.equal(s.sentText,".",`${id}: expected continuation nudge`);
      if(id==="tool-fixed") assert((s.stopAt||0)<1000,"tool DOM must not select a longer timeout");
      if(id!=="disabled-until-input") assert((statusCounts.get(id)||0)>=2,`${id}: expected two stream confirmations`);
    }
    await openCase(driver,"slow-stop"); await waitFor(driver,"return window.__state.stopClicks===1",3000); await waitFor(driver,"return (document.querySelector('#cg-conversation-guard-status')?.textContent||'').includes('stopping')",1500); await driver.sleep(350);
    let s=await state(driver); assert.equal(s.sends,0); assert.equal(s.draft,""); let recoveryUi=await driver.executeScript("const b=document.querySelector('#cg-conversation-guard-status'); return {phase:b?.dataset?.recoveryPhase||null,state:b?.querySelector('.cg-state')?.textContent||''}"); assert.equal(recoveryUi?.phase,"stopping"); assert.equal(recoveryUi?.state,"stopping"); await waitFor(driver,"return window.__state.sends===1",5000); s=await state(driver); assert(s.sendAt-s.stopAt>=600);
    await openCase(driver,"stale-stopped-dom"); await waitFor(driver,"return window.__state.sends===1",5000); s=await state(driver); assert.equal(s.stopClicks,1,"captured stale-DOM case must Stop exactly once"); assert.equal(s.staleMarkersAtStop,1,"fixture must preserve the stale historical streaming marker after Stop"); assert.equal(s.sentText,".","stale historical streaming DOM must not pin recovery in stopping");
    await openCase(driver,"system-delay-banner"); await waitFor(driver,"return window.__state.sends===1",2500); assert.equal((await state(driver)).sentText,".");
    await openCase(driver,"draft-protection"); await driver.sleep(700); s=await state(driver); assert.equal(s.stopClicks,0); assert.equal(s.sends,0); assert.equal(s.draft,"do not overwrite me");
    await openCase(driver,"pre-output-loading"); await waitFor(driver,"return (document.querySelector('#cg-conversation-guard-status')?.textContent||'').includes('loading')",1500); await driver.sleep(500); assert.equal((await state(driver)).stopClicks,0); assert.equal(await driver.executeScript("return window.__revealAssistantOutput()"),true); await waitFor(driver,"return window.__state.sends===1",5000);
    console.log("Firefox stall-recovery E2E: PASS",JSON.stringify({addonId,statusCounts:Object.fromEntries(statusCounts)}));
  } finally { await driver.quit().catch(()=>{}); await new Promise((resolve)=>server.close(resolve)); fs.rmSync(temp,{recursive:true,force:true}); }
})().catch((error)=>{console.error(error&&error.stack||error);process.exit(1);});