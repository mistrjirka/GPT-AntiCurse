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
  window.__fixtureStarted = true;
  window.__fixtureErrors = [];
  window.addEventListener('error', e => window.__fixtureErrors.push(String(e.error?.stack || e.message || 'fixture error')));
  const id = location.pathname.split('/').filter(Boolean).pop();
  const key = '__ac_fixture_state:' + id;
  const old = JSON.parse(sessionStorage.getItem(key) || '{}');
  const s = {loads:Number(old.loads||0)+1, stopClicks:Number(old.stopClicks||0), sends:Number(old.sends||0), sentText:old.sentText||'', trustedInputEvents:Number(old.trustedInputEvents||0)};
  window.__state = s;
  const save = () => sessionStorage.setItem(key, JSON.stringify(s));
  save();
  const list=document.getElementById('turn-list'), composer=document.getElementById('prompt-textarea'), form=composer.closest('form'), button=document.getElementById('composer-submit-button'), modelLabel=document.querySelector('[data-animated-slider-trigger="true"]');
  if(!list||!composer||!form||!button||!modelLabel) throw new Error('incomplete fixture DOM');
  const second=s.loads>=2;
  modelLabel.textContent=id==='reload-pro'&&second?'Pro':'Thinking';
  const sync=()=>{Object.assign(window.__state,s);save();};
  function turn(n,{output=true,streaming=true,model='gpt-5-6-thinking'}={}){
    const w=document.createElement('div');w.setAttribute('data-turn-id-container','turn-'+n);
    const section=document.createElement('section');section.setAttribute('data-testid','conversation-turn-'+n);section.setAttribute('data-turn-id','turn-'+n);section.setAttribute('data-turn','assistant');
    const msg=document.createElement('div');msg.setAttribute('data-message-author-role','assistant');msg.setAttribute('data-message-model-slug',model);
    if(output){const md=document.createElement('div');md.className='markdown';md.textContent='assistant output '+n;msg.append(md);}section.append(msg);
    const stream=document.createElement('div');if(streaming)stream.setAttribute('data-streaming-response-status','streaming');section.append(stream);w.append(section);list.append(w);return{wrapper:w,stream};
  }
  const setStop=()=>{button.setAttribute('data-testid','stop-button');button.textContent='Stop';button.disabled=false;};
  const setSend=(disabled=false)=>{button.setAttribute('data-testid','send-button');button.textContent='Send';button.disabled=disabled;};
  const reloadCase=id.startsWith('reload-')||id==='pre-output-reload'||id==='shell-loading-reload';
  let active=null;
  if(reloadCase&&second){
    if(id==='reload-running'||id==='reload-loop'){active=turn(1,{output:true,streaming:true});setStop();}
    else if(id==='reload-stopped-stale'){turn(0,{output:true,streaming:true});active=turn(1,{output:true,streaming:false});setSend(false);}
    else {active=turn(1,{output:true,streaming:false});setSend(id==='reload-send-not-ready');}
  }else if(id==='shell-loading-reload'){form.setAttribute('inert','');document.documentElement.setAttribute('data-stream-active','true');setStop();}
  else {active=turn(1,{output:id!=='pre-output-reload',streaming:true});setStop();}
  if(id==='stale-stop'&&active){const stale=turn(-1,{output:true,streaming:true});list.insertBefore(stale.wrapper,active.wrapper);}
  if(id==='system-delay-banner'&&active){const b=document.createElement('span');b.className='loading-shimmer-tertiary';b.append('Our systems are thinking a bit more about this request before responding. ');const a=document.createElement('a');a.href='https://help.openai.com/articles/20001326';a.textContent='Learn more';b.append(a);active.stream.append(b);}
  if(id==='draft-protection')composer.textContent='do not overwrite me';
  composer.addEventListener('input',e=>{if(e.isTrusted)s.trustedInputEvents++;if(id==='controlled-editor'&&e.isTrusted&&(composer.textContent||'').trim()==='.'&&button.getAttribute('data-testid')!=='stop-button')button.disabled=false;sync();});
  button.addEventListener('click',()=>{
    if(button.getAttribute('data-testid')==='stop-button'){
      s.stopClicks++;sync();
      if(id==='reload-loop'&&second)return;
      setSend(id==='controlled-editor'||id==='reload-send-not-ready');
      if(id==='slow-stop')setTimeout(()=>{active?.stream?.removeAttribute('data-streaming-response-status');button.disabled=false;},650);
      else active?.stream?.removeAttribute('data-streaming-response-status');
      return;
    }
    if(button.disabled)return;
    s.sends++;s.sentText=(composer.textContent||'').trim();sync();composer.replaceChildren();active=turn(10+s.sends,{output:true,streaming:true});setStop();
  });
})();
</script></body></html>`;
}

const isWorker=w=>/^chrome-extension:\/\//.test(w.url())&&/\/background-entry\.js(?:$|[?#])/.test(w.url());
async function worker(context){return context.serviceWorkers().find(isWorker)||context.waitForEvent('serviceworker',isWorker);}
async function configure(w){const end=Date.now()+10000;while(Date.now()<end){if(await w.evaluate(()=>!!(globalThis.chrome&&chrome.storage&&chrome.storage.local)).catch(()=>false)){await w.evaluate(()=>chrome.storage.local.set({enabled:false,showGuardNotice:true,stallRecoveryEnabled:true}));return;}await new Promise(r=>setTimeout(r,50));}throw new Error('storage API not ready');}
async function openCase(context,id){
  console.log('CASE '+id);
  const page=await context.newPage();
  page.on('pageerror',e=>console.error('PAGEERROR '+id+':',e?.stack||e));
  page.on('console',m=>{if(m.type()==='error')console.error('CONSOLE '+id+':',m.text());});
  await page.goto('https://chatgpt.com/c/'+id,{waitUntil:'domcontentloaded',timeout:5000});
  try{
    await page.waitForFunction(()=>!!window.__state||!!window.__fixtureErrors?.length,null,{timeout:5000});
  }catch(error){
    const diag=await page.evaluate(()=>({url:location.href,title:document.title,ready:document.readyState,fixtureStarted:!!window.__fixtureStarted,state:window.__state||null,errors:window.__fixtureErrors||null,body:(document.body?.innerText||'').slice(0,500),csp:document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content||null})).catch(e=>({evalError:String(e)}));
    console.error('FIXTURE DIAG '+id+': '+JSON.stringify(diag));
    throw error;
  }
  const errors=await page.evaluate(()=>window.__fixtureErrors||[]);if(errors.length)throw new Error('fixture '+id+': '+errors.join(' | '));
  return page;
}
const state=p=>p.evaluate(()=>({...window.__state,draft:document.querySelector('#prompt-textarea')?.textContent||''}));
async function recoveryDiag(p){
  return p.evaluate(()=>{
    const button=document.querySelector('#composer-submit-button');
    const composer=document.querySelector('#prompt-textarea');
    const recovery=globalThis.CGAntiCurseStallRecovery;
    const guard=globalThis.CGAntiCurseProRecoveryGuard;
    const input=globalThis.CGAntiCurseComposerInput;
    const reload=globalThis.CGAntiCurseRecoveryReloadState;
    let r=null,g=null,i=null,l=null;
    try{r=recovery?.debug?.()||null;}catch(e){r={error:String(e)}}
    try{g=guard?.debug?.()||null;}catch(e){g={error:String(e)}}
    try{i=input?.debug?.()||null;}catch(e){i={error:String(e)}}
    try{l=reload?.debug?.()||null;}catch(e){l={error:String(e)}}
    return {fixture:window.__state||null,recovery:r,guard:g,input:i,reload:l,button:{testid:button?.getAttribute('data-testid')||null,disabled:!!button?.disabled,ariaDisabled:button?.getAttribute('aria-disabled')||null},composer:composer?.textContent||'',ready:document.readyState};
  });
}
async function waitForSend(p,id,timeout){
  try{await p.waitForFunction(()=>window.__state.sends===1,null,{timeout});}
  catch(error){console.error('RECOVERY DIAG '+id+': '+JSON.stringify(await recoveryDiag(p).catch(e=>({evalError:String(e)}))));throw error;}
}

(async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'anticurse-stall-e2e-')),ext=path.join(tmp,'chrome'),profile=path.join(tmp,'profile');
  fs.cpSync(path.join(ROOT,'chrome'),ext,{recursive:true});
  const watchdogPath=path.join(ext,'stall-recovery.js');let watchdog=fs.readFileSync(watchdogPath,'utf8');watchdog=watchdog.replace('const STALL_TIMEOUT_MS = 120_000;','const STALL_TIMEOUT_MS = 200;').replace('const PHASE_TIMEOUT_MS = 120_000;','const PHASE_TIMEOUT_MS = 1_500;').replace('const SEND_CONFIRM_TIMEOUT_MS = 30_000;','const SEND_CONFIRM_TIMEOUT_MS = 1_500;');fs.writeFileSync(watchdogPath,watchdog);
  const counts=new Map();
  const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});
  try{
    await context.route('https://chatgpt.com/c/**',r=>{console.log('FIXTURE ROUTE '+r.request().url());return r.fulfill({status:200,contentType:'text/html',headers:{'cache-control':'no-store'},body:fixtureHtml()});});
    await context.route('https://chatgpt.com/api/auth/session',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({accessToken:'stall-e2e-token'})}));
    await context.route(/https:\/\/chatgpt\.com\/backend-api\/conversation\/[^/]+\/stream_status$/,async r=>{
      const id=decodeURIComponent(new URL(r.request().url()).pathname.match(/\/conversation\/([^/]+)\/stream_status$/)[1]);const n=(counts.get(id)||0)+1;counts.set(id,n);
      if(id==='reload-stopped-stale'&&n>=4){await r.fulfill({status:503,contentType:'application/json',body:'{}'});return;}
      let streaming;if(['pre-output-reload','shell-loading-reload'].includes(id))streaming=false;else if(id==='reload-stopped-stale')streaming=n<=3;else if(id==='reload-running')streaming=n<=4;else if(id==='reload-pro')streaming=n<=3;else if(id==='reload-loop')streaming=true;else if(id==='reload-send-not-ready')streaming=n<=2;else if(id==='system-delay-banner')streaming=false;else streaming=n<=2;
      await r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({status:streaming?'IS_STREAMING':'NOT_STREAMING'})});
    });
    await configure(await worker(context));
    for(const id of ['basic','tool-fixed','controlled-editor','stale-stop']){const p=await openCase(context,id);await waitForSend(p,id,6000);const s=await state(p);assert.equal(s.stopClicks,1,id+': one Stop');assert.equal(s.sentText,'.',id+': dot');assert((counts.get(id)||0)>=3,id+': backend checks');if(id==='controlled-editor')assert(s.trustedInputEvents>=1,'native editor event required');await p.close();}
    {const p=await openCase(context,'slow-stop');await p.waitForFunction(()=>window.__state.stopClicks===1,null,{timeout:4000});await p.waitForFunction(()=>(document.querySelector('#cg-conversation-guard-status')?.textContent||'').includes('stopping'),null,{timeout:1500});await p.waitForTimeout(350);let s=await state(p);assert.equal(s.sends,0);assert.equal(s.draft,'');await waitForSend(p,'slow-stop',5000);assert.equal((await state(p)).sentText,'.');await p.close();}
    {const p=await openCase(context,'system-delay-banner');await waitForSend(p,'system-delay-banner',3500);assert.equal((await state(p)).sentText,'.');await p.close();}
    {const p=await openCase(context,'draft-protection');await p.waitForTimeout(700);const s=await state(p);assert.equal(s.stopClicks,0);assert.equal(s.sends,0);assert.equal(s.draft,'do not overwrite me');await p.close();}
    for(const id of ['pre-output-reload','shell-loading-reload','reload-stopped-stale']){const p=await openCase(context,id);await p.waitForFunction(()=>window.__state.loads>=2,null,{timeout:5000});await waitForSend(p,id,6000);const s=await state(p);assert.equal(s.loads,2,id+': one reload');assert.equal(s.sentText,'.');await p.close();}
    {const p=await openCase(context,'reload-running');await p.waitForFunction(()=>window.__state.loads>=2,null,{timeout:5000});await waitForSend(p,'reload-running',7000);const s=await state(p);assert.equal(s.loads,2);assert.equal(s.stopClicks,2);assert.equal(s.sentText,'.');await p.close();}
    {const p=await openCase(context,'reload-pro');await p.waitForFunction(()=>window.__state.loads>=2,null,{timeout:5000});await p.waitForTimeout(1200);const s=await state(p);assert.equal(s.loads,2);assert.equal(s.sends,0);await p.close();}
    {const p=await openCase(context,'reload-loop');await p.waitForFunction(()=>window.__state.loads>=2,null,{timeout:5000});await p.waitForTimeout(3800);const s=await state(p);assert.equal(s.loads,2,'no second reload');assert.equal(s.sends,0);await p.close();}
    {const p=await openCase(context,'reload-send-not-ready');await p.waitForFunction(()=>window.__state.loads>=2,null,{timeout:5000});await p.waitForTimeout(2400);const s=await state(p);assert.equal(s.loads,2);assert.equal(s.sends,0);assert.equal(s.draft,'','failed post-reload Send must roll back dot');await p.close();}
    console.log('Chromium stall-recovery 0.7.6 E2E: PASS',JSON.stringify(Object.fromEntries(counts)));
  }finally{await context.close();fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e?.stack||e);process.exit(1);});
