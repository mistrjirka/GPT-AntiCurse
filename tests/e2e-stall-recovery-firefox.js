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
  function syncState(){ Object.assign(window.__state,persistent); save(); }

  function makeTurn(index,{output=true,streaming=true,model='gpt-5-6-thinking'}={}){
    const wrapper=document.createElement('div'); wrapper.setAttribute('data-turn-id-container','turn-'+index);
    const section=document.createElement('section'); section.setAttribute('data-testid','conversation-turn-'+index); section.setAttribute('data-turn-id','turn-'+index); section.setAttribute('data-turn','assistant');
    const message=document.createElement('div'); message.setAttribute('data-message-author-role','assistant'); message.setAttribute('data-message-model-slug',model);
    if(output){ const markdown=document.createElement('div'); markdown.className='markdown'; markdown.textContent='assistant output '+index; message.append(markdown); }
    section.append(message); const stream=document.createElement('div'); if(streaming) stream.setAttribute('data-streaming-response-status','streaming'); section.append(stream); wrapper.append(section); list.append(wrapper); return {wrapper,stream,message};
  }
  function setStop(){ button.setAttribute('data-testid','stop-button'); button.textContent='Stop'; button.disabled=false; }
  function setSend(disabled=false){ button.setAttribute('data-testid','send-button'); button.textContent='Send'; button.disabled=disabled; }

  const reloadCase=id.startsWith('reload-')||id==='pre-output-reload'||id==='shell-loading-reload';
  let active=null;
  if(reloadCase&&secondLoad){
    if(id==='reload-running'||id==='reload-loop'){ active=makeTurn(1,{output:true,streaming:true}); setStop(); }
    else if(id==='reload-stopped-stale'){ makeTurn(0,{output:true,streaming:true}); active=makeTurn(1,{output:true,streaming:false}); setSend(false); }
    else { active=makeTurn(1,{output:true,streaming:false}); setSend(id==='reload-send-not-ready'); }
  } else if(id==='shell-loading-reload'){
    form.setAttribute('inert',''); document.documentElement.setAttribute('data-stream-active','true'); setStop();
  } else { active=makeTurn(1,{output:id!=='pre-output-reload',streaming:true}); setStop(); }

  if(id==='stale-stop') makeTurn(-1,{output:true,streaming:true});
  if(id==='system-delay-banner'&&active){ const b=document.createElement('span'); b.className='loading-shimmer-tertiary'; b.append('Our systems are thinking a bit more about this request before responding. '); const a=document.createElement('a'); a.href='https://help.openai.com/articles/20001326'; a.textContent='Learn more'; b.append(a); active.stream.append(b); }
  if(id==='draft-protection') composer.textContent='do not overwrite me';

  composer.addEventListener('input',(event)=>{
    if(event.isTrusted) persistent.trustedInputEvents++;
    if(id==='controlled-editor'&&event.isTrusted&&(composer.textContent||'').trim()==='.'&&button.getAttribute('data-testid')!=='stop-button') button.disabled=false;
    syncState();
  });

  button.addEventListener('click',()=>{
    if(button.getAttribute('data-testid')==='stop-button'){
      persistent.stopClicks++; syncState();
      if(id==='reload-loop'&&secondLoad) return;
      setSend(id==='controlled-editor'||id==='reload-send-not-ready');
      if(id==='slow-stop') setTimeout(()=>{active?.stream?.removeAttribute('data-streaming-response-status');button.disabled=false;},650);
      else active?.stream?.removeAttribute('data-streaming-response-status');
      return;
    }
    if(button.disabled) return;
    persistent.sends++; persistent.sentText=(composer.textContent||'').trim(); syncState(); composer.replaceChildren(); active=makeTurn(10+persistent.sends,{output:true,streaming:true}); setStop();
  });
})();
</script></body></html>`;
}

function createCertificate(dir){
  const key=path.join(dir,"key.pem"),cert=path.join(dir,"cert.pem");
  execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=chatgpt.com","-addext","subjectAltName=DNS:chatgpt.com"],{stdio:"ignore"});
  return {key:fs.readFileSync(key),cert:fs.readFileSync(cert)};
}
function createServer(tls,statusCounts){
  return https.createServer(tls,(req,res)=>{
    const url=new URL(req.url,"https://chatgpt.com:8443");
    if(/^\/c\/[^/]+$/.test(url.pathname)){res.writeHead(200,{"content-type":"text/html; charset=utf-8"});res.end(fixtureHtml());return;}
    if(url.pathname==="/api/auth/session"){res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({accessToken:"stall-firefox-token"}));return;}
    const m=url.pathname.match(/^\/backend-api\/conversation\/([^/]+)\/stream_status$/);
    if(m){
      const id=decodeURIComponent(m[1]); const count=(statusCounts.get(id)||0)+1; statusCounts.set(id,count); assert.equal(req.headers.authorization||"","Bearer stall-firefox-token");
      if(id==="reload-stopped-stale"){res.writeHead(503,{"content-type":"application/json"});res.end("{}");return;}
      let streaming;
      if(["pre-output-reload","shell-loading-reload","reload-pro","reload-send-not-ready"].includes(id)) streaming=false;
      else if(id==="reload-running") streaming=count===1;
      else if(id==="reload-loop") streaming=true;
      else if(id==="system-delay-banner") streaming=false;
      else streaming=count<=2;
      res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({status:streaming?"IS_STREAMING":"NOT_STREAMING"}));return;
    }
    res.writeHead(404,{"content-type":"text/plain"});res.end("not found");
  });
}
async function waitFor(driver,script,timeout=6000){await driver.wait(async()=>{try{return !!(await driver.executeScript(script));}catch{return false;}},timeout);}
async function state(driver){return driver.executeScript("return {...window.__state,draft:document.querySelector('#prompt-textarea')?.textContent||'',href:location.href}");}
async function openCase(driver,id){await driver.get(`https://chatgpt.com:8443/c/${id}`);await waitFor(driver,"return !!window.__state");}

(async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"anticurse-stall-firefox-e2e-"));
  const extensionDir=path.join(temp,"firefox"),xpi=path.join(temp,"gpt-anticurse-firefox.xpi");
  fs.cpSync(path.join(ROOT,"firefox"),extensionDir,{recursive:true});
  const watchdogPath=path.join(extensionDir,"stall-recovery.js");
  let watchdog=fs.readFileSync(watchdogPath,"utf8");
  watchdog=watchdog.replace("const STALL_TIMEOUT_MS = 120_000;","const STALL_TIMEOUT_MS = 200;").replace("const PHASE_TIMEOUT_MS = 120_000;","const PHASE_TIMEOUT_MS = 1_500;").replace("const SEND_CONFIRM_TIMEOUT_MS = 30_000;","const SEND_CONFIRM_TIMEOUT_MS = 1_500;");
  fs.writeFileSync(watchdogPath,watchdog);execFileSync("zip",["-qr",xpi,"."],{cwd:extensionDir});
  const statusCounts=new Map();const server=createServer(createCertificate(temp),statusCounts);
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(8443,"0.0.0.0",resolve);});
  const options=new firefox.Options().addArguments("-headless").setAcceptInsecureCerts(true).setPreference("browser.cache.disk.enable",false).setPreference("browser.cache.memory.enable",false).setPreference("network.dns.localDomains","chatgpt.com");
  if(process.env.FIREFOX_BIN)options.setBinary(process.env.FIREFOX_BIN);
  const driver=await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
  try{
    const addonId=await driver.installAddon(xpi,true);assert(addonId);
    for(const id of ["basic","tool-fixed","controlled-editor","stale-stop"]){
      await openCase(driver,id);await waitFor(driver,"return window.__state.sends===1");const s=await state(driver);assert.equal(s.stopClicks,1,`${id}: expected exactly one Stop`);assert.equal(s.sentText,".",`${id}: expected continuation nudge`);assert((statusCounts.get(id)||0)>=3,`${id}: expected two stall confirmations plus Stop settlement`);if(id==="controlled-editor")assert(s.trustedInputEvents>=1,"controlled editor must receive native edit event");
    }
    await openCase(driver,"slow-stop");await waitFor(driver,"return window.__state.stopClicks===1",4000);await waitFor(driver,"return (document.querySelector('#cg-conversation-guard-status')?.textContent||'').includes('stopping')",1500);await driver.sleep(350);let s=await state(driver);assert.equal(s.sends,0);assert.equal(s.draft,"");await waitFor(driver,"return window.__state.sends===1",5000);assert.equal((await state(driver)).sentText,".");
    await openCase(driver,"system-delay-banner");await waitFor(driver,"return window.__state.sends===1",3500);assert.equal((await state(driver)).sentText,".");
    await openCase(driver,"draft-protection");await driver.sleep(700);s=await state(driver);assert.equal(s.stopClicks,0);assert.equal(s.sends,0);assert.equal(s.draft,"do not overwrite me");
    for(const id of ["pre-output-reload","shell-loading-reload","reload-stopped-stale"]){await openCase(driver,id);await waitFor(driver,"return window.__state.loads>=2",5000);await waitFor(driver,"return window.__state.sends===1",6000);s=await state(driver);assert.equal(s.loads,2,`${id}: exactly one reload expected`);assert.equal(s.sentText,".",`${id}: stopped page must resume`);}
    await openCase(driver,"reload-running");await waitFor(driver,"return window.__state.loads>=2",5000);await waitFor(driver,"return window.__state.sends===1",6000);s=await state(driver);assert.equal(s.loads,2);assert.equal(s.stopClicks,1);assert.equal(s.sentText,".");
    await openCase(driver,"reload-pro");await waitFor(driver,"return window.__state.loads>=2",5000);await driver.sleep(1200);s=await state(driver);assert.equal(s.loads,2);assert.equal(s.sends,0,"Pro after reload must not receive nudge");
    await openCase(driver,"reload-loop");await waitFor(driver,"return window.__state.loads>=2",5000);await driver.sleep(3800);s=await state(driver);assert.equal(s.loads,2,"failed post-reload recovery must not reload again");assert.equal(s.sends,0);
    console.log("Firefox stall-recovery 0.7.6 E2E: PASS",JSON.stringify({addonId,statusCounts:Object.fromEntries(statusCounts)}));
  }finally{await driver.quit().catch(()=>{});await new Promise((resolve)=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
})().catch((error)=>{console.error(error&&error.stack||error);process.exit(1);});
