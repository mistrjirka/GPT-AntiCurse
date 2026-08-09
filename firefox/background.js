"use strict";

const DEFAULT_SETTINGS = { enabled: true, mode: "visible-history", maxDisplayMessages: 32, showGuardNotice: true };
const EMPTY_TOTALS = Object.freeze({ responsesTrimmed:0, nodesRemoved:0, nodesDelivered:0, visibleTurnsKept:0, inputBytes:0, outputBytes:0, bytesRemoved:0 });
let settings = { ...DEFAULT_SETTINGS };
let totals = { ...EMPTY_TOTALS };
const lastStatsByTab = new Map();
const windowHistoryByTab = new Map();

function normalizeTotals(value){ const out={...EMPTY_TOTALS}; if(!value||typeof value!=="object")return out; for(const key of Object.keys(out)){const n=Number(value[key]);if(Number.isFinite(n)&&n>=0)out[key]=n;} return out; }
browser.storage.local.get({ ...DEFAULT_SETTINGS, cgTotals: EMPTY_TOTALS }).then((saved)=>{settings={...DEFAULT_SETTINGS,...saved};totals=normalizeTotals(saved.cgTotals);}).catch(console.error);
browser.storage.onChanged.addListener((changes,area)=>{ if(area!=="local")return; for(const key of Object.keys(DEFAULT_SETTINGS)) if(changes[key]) settings[key]=changes[key].newValue; if(changes.cgTotals) totals=normalizeTotals(changes.cgTotals.newValue); });
function isExactConversationDocument(urlString){ try{return /^\/backend-api\/conversation\/[^/]+\/?$/.test(new URL(urlString).pathname);}catch(_){return false;} }
function safeSetAction(tabId,text,title){ if(tabId<0)return; browser.action.setBadgeText({tabId,text}).catch(()=>{}); browser.action.setTitle({tabId,title}).catch(()=>{}); }
function percentRemoved(stats){ const before=Number(stats.mappingNodesBefore)||0,after=Number(stats.mappingNodesAfter)||0; return before>0?Math.max(0,Math.min(100,((before-after)/before)*100)):0; }
function recordTotals(stats){
  if(!stats||stats.mode!=="trimmed")return stats;
  const before=Math.max(0,Number(stats.mappingNodesBefore)||0),after=Math.max(0,Number(stats.mappingNodesAfter)||0),removed=Math.max(0,Number(stats.discardedNodes)||(before-after));
  const inputBytes=Math.max(0,Number(stats.originalBytes)||0),outputBytes=Math.max(0,Number(stats.outputBytes)||0),bytesRemoved=inputBytes&&outputBytes?Math.max(0,inputBytes-outputBytes):0;
  totals={responsesTrimmed:totals.responsesTrimmed+1,nodesRemoved:totals.nodesRemoved+removed,nodesDelivered:totals.nodesDelivered+after,visibleTurnsKept:totals.visibleTurnsKept+Math.max(0,Number(stats.displayAfter)||0),inputBytes:totals.inputBytes+inputBytes,outputBytes:totals.outputBytes+outputBytes,bytesRemoved:totals.bytesRemoved+bytesRemoved};
  browser.storage.local.set({cgTotals:totals}).catch(()=>{}); return {...stats,totals:{...totals}};
}
function publishStats(tabId,rawStats){ if(tabId<0)return; const stats=recordTotals(rawStats); lastStatsByTab.set(tabId,stats); const saved=Math.round(percentRemoved(stats)); const badge=stats.mode==="trimmed"?`${saved}%`:stats.mode==="error"?"ERR":"OK"; const title=stats.mode==="trimmed"?`GPT AntiCurse: removed ${stats.discardedNodes||(stats.mappingNodesBefore-stats.mappingNodesAfter)} of ${stats.mappingNodesBefore} mapping nodes (${saved}%); kept ${stats.displayAfter} visible turns`:stats.mode==="error"?`GPT AntiCurse error: original response passed through (${stats.error})`:"GPT AntiCurse: response unchanged"; safeSetAction(tabId,badge,title); browser.tabs.sendMessage(tabId,{type:"cg-stats",stats}).catch(()=>{}); }
function writeOriginal(filter,chunks){for(const chunk of chunks)filter.write(chunk);}
function concatChunks(chunks,totalBytes){const merged=new Uint8Array(totalBytes);let offset=0;for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.byteLength;}return merged;}

function interceptConversation(details){
  if(!settings.enabled||details.method!=="GET"||!isExactConversationDocument(details.url))return {};
  const filter=browser.webRequest.filterResponseData(details.requestId),chunks=[]; let totalBytes=0;
  filter.ondata=(event)=>{const bytes=new Uint8Array(event.data),copy=new Uint8Array(bytes.byteLength);copy.set(bytes);chunks.push(copy);totalBytes+=copy.byteLength;};
  filter.onstop=()=>{
    const started=performance.now();
    try{
      const merged=concatChunks(chunks,totalBytes); let text=new TextDecoder("utf-8").decode(merged); if(text.charCodeAt(0)===0xfeff)text=text.slice(1); const parsed=JSON.parse(text);
      const trimMode=["visible-history","recent","latest-visible","windowed-visible"].includes(settings.mode)?settings.mode:"visible-history";
      const limit=Math.max(4,Math.min(500,Number(settings.maxDisplayMessages)||32));
      const archiveMode=["recent","latest-visible","windowed-visible"].includes(trimMode);
      const visibleArchive=archiveMode?CGTrim.extractVisibleHistory(parsed):null;
      const transformed=CGTrim.trimConversation(parsed,{mode:trimMode,maxDisplayMessages:limit});

      if(archiveMode&&visibleArchive){
        const nativeVisibleCount=transformed.stats&&Number.isFinite(Number(transformed.stats.displayAfter))?Math.max(0,Number(transformed.stats.displayAfter)):Math.min(visibleArchive.length,limit);
        const history={messages:visibleArchive,nativeVisibleCount,pageSize:limit,maxRendered:Math.max(limit,Math.min(500,limit*3))};
        windowHistoryByTab.set(details.tabId,history);
        browser.tabs.sendMessage(details.tabId,{type:"cg-window-history",history}).catch(()=>{});
      } else {
        windowHistoryByTab.delete(details.tabId);
        browser.tabs.sendMessage(details.tabId,{type:"cg-window-history",history:null}).catch(()=>{});
      }

      if(!transformed.changed){
        writeOriginal(filter,chunks);
        if(transformed.reason!=="unsupported-shape") publishStats(details.tabId,{mode:"passthrough",reason:transformed.reason,originalBytes:totalBytes,processingMs:+(performance.now()-started).toFixed(2),...(transformed.stats||{})});
      } else {
        const output=new TextEncoder().encode(JSON.stringify(transformed.data)); filter.write(output); publishStats(details.tabId,{mode:"trimmed",transport:"firefox-stream-filter",originalBytes:totalBytes,outputBytes:output.byteLength,processingMs:+(performance.now()-started).toFixed(2),...transformed.stats});
      }
    }catch(error){ try{writeOriginal(filter,chunks);}catch(_){} publishStats(details.tabId,{mode:"error",transport:"firefox-stream-filter",error:String(error&&error.message?error.message:error),originalBytes:totalBytes,processingMs:+(performance.now()-started).toFixed(2)}); }
    finally{try{filter.close();}catch(_){}}
  };
  filter.onerror=()=>publishStats(details.tabId,{mode:"error",transport:"firefox-stream-filter",error:filter.error||"StreamFilter error"});
  return {};
}

browser.webRequest.onBeforeRequest.addListener(interceptConversation,{urls:["https://chatgpt.com/backend-api/conversation/*"]},["blocking"]);
browser.runtime.onMessage.addListener((message,sender)=>{
  if(message&&message.type==="cg-get-stats"){const tabId=sender.tab?sender.tab.id:message.tabId;return Promise.resolve(lastStatsByTab.get(tabId)||null);}
  if(message&&message.type==="cg-get-window-history"){const tabId=sender.tab?sender.tab.id:message.tabId;return Promise.resolve(windowHistoryByTab.get(tabId)||null);}
  if(message&&message.type==="cg-get-totals")return Promise.resolve({...totals});
  if(message&&message.type==="cg-reset-totals"){totals={...EMPTY_TOTALS};return browser.storage.local.set({cgTotals:totals}).then(()=>({...totals}));}
  if(message&&message.type==="cg-settings"){
    const next={}; if(typeof message.enabled==="boolean")next.enabled=message.enabled; if(["visible-history","recent","latest-visible","windowed-visible"].includes(message.mode))next.mode=message.mode; if(Number.isFinite(Number(message.maxDisplayMessages)))next.maxDisplayMessages=Math.max(4,Math.min(500,Number(message.maxDisplayMessages))); if(typeof message.showGuardNotice==="boolean")next.showGuardNotice=message.showGuardNotice;
    return browser.storage.local.set(next).then(()=>{settings={...settings,...next};return settings;});
  }
  return undefined;
});
browser.tabs.onRemoved.addListener((tabId)=>{lastStatsByTab.delete(tabId);windowHistoryByTab.delete(tabId);});
