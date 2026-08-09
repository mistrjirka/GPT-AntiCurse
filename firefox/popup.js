"use strict";

const enabled = document.getElementById("enabled");
const mode = document.getElementById("mode");
const limit = document.getElementById("limit");
const showNotice = document.getElementById("showNotice");
const loadPrevious = document.getElementById("loadPrevious");
const feedback = document.getElementById("feedback");
const nf = new Intl.NumberFormat();
const EMPTY_TOTALS = { responsesTrimmed:0, nodesRemoved:0, nodesDelivered:0, visibleTurnsKept:0, inputBytes:0, outputBytes:0, bytesRemoved:0 };

function fmt(n) { const v=Number(n); return nf.format(Number.isFinite(v)?v:0); }
function fmtBytes(n) { let v=Math.max(0,Number(n)||0), i=0; const u=["B","KB","MB","GB"]; while(v>=1024&&i<u.length-1){v/=1024;i++;} return `${v>=10||i===0?v.toFixed(0):v.toFixed(1)} ${u[i]}`; }
function limitedMode() { return mode.value !== "visible-history"; }
function updateControls() { limit.disabled=!limitedMode(); loadPrevious.disabled=!limitedMode(); loadPrevious.textContent=`Load previous ${Math.max(4,Math.min(500,Number(limit.value)||32))}`; }
async function currentTab(){ const tabs=await browser.tabs.query({active:true,currentWindow:true}); return tabs[0]; }
async function save(){ await browser.runtime.sendMessage({type:"cg-settings",enabled:enabled.checked,mode:mode.value,maxDisplayMessages:Number(limit.value),showGuardNotice:showNotice.checked}); }
async function reload(){ await save(); const tab=await currentTab(); if(tab&&tab.id!=null) await browser.tabs.reload(tab.id); window.close(); }
function setFeedback(text){ feedback.textContent=text||""; }
function renderTotals(t){ t={...EMPTY_TOTALS,...(t||{})}; document.getElementById("totalResponses").textContent=fmt(t.responsesTrimmed); document.getElementById("totalRemoved").textContent=fmt(t.nodesRemoved); document.getElementById("totalBytes").textContent=fmtBytes(t.bytesRemoved); }
function setStatus(text,kind=""){ const el=document.getElementById("statusPill"); el.textContent=text; el.className=`status${kind?` ${kind}`:""}`; }
function renderStats(s){
  if(!s){setStatus("Waiting");return;}
  if(s.mode==="trimmed"){
    const before=Math.max(0,Number(s.mappingNodesBefore)||0), after=Math.max(0,Number(s.mappingNodesAfter)||0), removed=Math.max(0,Number(s.discardedNodes)||(before-after));
    const pct=before?Math.max(0,Math.min(100,(removed/before)*100)):0;
    document.getElementById("savedPct").textContent=`${pct>=99.5?pct.toFixed(1):Math.round(pct)}%`;
    document.getElementById("summaryText").textContent=`${fmt(before)} → ${fmt(after)} nodes`;
    document.getElementById("summarySub").textContent=`${fmt(Number(s.displayAfter)||0)} visible turns kept in ChatGPT`;
    document.getElementById("removedNodes").textContent=fmt(removed);
    if(Number.isFinite(Number(s.originalBytes))&&Number.isFinite(Number(s.outputBytes))) document.getElementById("bytesSaved").textContent=fmtBytes(Math.max(0,Number(s.originalBytes)-Number(s.outputBytes)));
    else document.getElementById("bytesSaved").textContent="not measured";
    document.getElementById("processing").textContent=Number.isFinite(Number(s.processingMs))?`${s.processingMs} ms`:"—";
    setStatus("Active","active");
  } else if(s.mode==="error") { setStatus("Error","error"); document.getElementById("summaryText").textContent="Original response kept"; }
  else { setStatus("Ready","active"); document.getElementById("savedPct").textContent="0%"; document.getElementById("summaryText").textContent="No trimming needed"; }
}

browser.storage.local.get({enabled:true,mode:"visible-history",maxDisplayMessages:32,showGuardNotice:true,cgTotals:EMPTY_TOTALS}).then((s)=>{enabled.checked=s.enabled;mode.value=s.mode;limit.value=s.maxDisplayMessages;showNotice.checked=s.showGuardNotice!==false;renderTotals(s.cgTotals);updateControls();});

document.getElementById("reload").addEventListener("click",reload);
document.getElementById("resetTotals").addEventListener("click",async()=>renderTotals(await browser.runtime.sendMessage({type:"cg-reset-totals"})));
loadPrevious.addEventListener("click",async()=>{ await save(); const tab=await currentTab(); if(!tab||tab.id==null)return; try{ const r=await browser.tabs.sendMessage(tab.id,{type:"cg-open-window-history"}); if(r&&r.ok){window.close();return;} setFeedback(r&&r.reason==="no-history-archive"?"Reload this chat once to create its history archive.":"No older visible turns are available."); }catch(_){setFeedback("Open a ChatGPT conversation first.");} });
enabled.addEventListener("change",save); showNotice.addEventListener("change",save); mode.addEventListener("change",()=>{updateControls();save();}); limit.addEventListener("change",()=>{updateControls();save();});
currentTab().then(async(tab)=>{if(!tab||tab.id==null)return;renderStats(await browser.runtime.sendMessage({type:"cg-get-stats",tabId:tab.id}));}).catch(()=>{});
