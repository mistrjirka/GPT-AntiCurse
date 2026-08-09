(function () {
  "use strict";
  const CHANNEL="__gpt_anticurse_v1__";
  const DEFAULT_SETTINGS=Object.freeze({enabled:true,mode:"visible-history",maxDisplayMessages:32});
  let settings={...DEFAULT_SETTINGS};
  function isExactConversationDocument(urlString){try{const url=new URL(urlString,location.href);return url.origin===location.origin&&/^\/backend-api\/conversation\/[^/]+\/?$/.test(url.pathname);}catch(_){return false;}}
  function publishStats(stats){window.postMessage({channel:CHANNEL,type:"stats",stats},location.origin);}
  function publishHistory(history){window.postMessage({channel:CHANNEL,type:"history",history},location.origin);}
  function applySettings(next){if(!next||typeof next!=="object")return;if(typeof next.enabled==="boolean")settings.enabled=next.enabled;if(["visible-history","recent","latest-visible","windowed-visible"].includes(next.mode))settings.mode=next.mode;if(Number.isFinite(Number(next.maxDisplayMessages)))settings.maxDisplayMessages=Math.max(4,Math.min(500,Number(next.maxDisplayMessages)));}
  window.addEventListener("message",(event)=>{if(event.source!==window||event.origin!==location.origin)return;const msg=event.data;if(!msg||msg.channel!==CHANNEL||msg.type!=="settings")return;applySettings(msg.settings);});

  function transformParsed(data,originalBytes){
    const started=performance.now();
    const trimMode=["visible-history","recent","latest-visible","windowed-visible"].includes(settings.mode)?settings.mode:"visible-history";
    const limit=Math.max(4,Math.min(500,Number(settings.maxDisplayMessages)||32));
    const archiveMode=["recent","latest-visible","windowed-visible"].includes(trimMode);
    const visibleArchive=archiveMode?CGTrim.extractVisibleHistory(data):null;
    const transformed=CGTrim.trimConversation(data,{mode:trimMode,maxDisplayMessages:limit});
    if(archiveMode&&visibleArchive){
      const nativeVisibleCount=transformed.stats&&Number.isFinite(Number(transformed.stats.displayAfter))?Math.max(0,Number(transformed.stats.displayAfter)):Math.min(visibleArchive.length,limit);
      publishHistory({messages:visibleArchive,nativeVisibleCount,pageSize:limit,maxRendered:Math.max(limit,Math.min(500,limit*3))});
    }else publishHistory(null);
    if(!transformed.changed){if(transformed.reason!=="unsupported-shape")publishStats({mode:"passthrough",transport:"chromium-response-body",reason:transformed.reason,originalBytes,processingMs:+(performance.now()-started).toFixed(2),...(transformed.stats||{})});return{data,transformed:false};}
    let outputBytes;try{outputBytes=new TextEncoder().encode(JSON.stringify(transformed.data)).byteLength;}catch(_){outputBytes=undefined;}
    publishStats({mode:"trimmed",transport:"chromium-response-body",originalBytes,outputBytes,processingMs:+(performance.now()-started).toFixed(2),...transformed.stats});
    return{data:transformed.data,transformed:true};
  }

  const nativeJson=Response.prototype.json,nativeText=Response.prototype.text;
  Object.defineProperty(Response.prototype,"json",{configurable:true,writable:true,value:async function antiCurseJson(){const data=await nativeJson.call(this);if(!settings.enabled||!isExactConversationDocument(this.url))return data;try{return transformParsed(data,undefined).data;}catch(error){publishStats({mode:"error",transport:"chromium-response-json",error:String(error&&error.message?error.message:error)});return data;}}});
  Object.defineProperty(Response.prototype,"text",{configurable:true,writable:true,value:async function antiCurseText(){const text=await nativeText.call(this);if(!settings.enabled||!isExactConversationDocument(this.url))return text;try{let body=text;if(body.charCodeAt(0)===0xfeff)body=body.slice(1);const parsed=JSON.parse(body),result=transformParsed(parsed,new TextEncoder().encode(text).byteLength);return result.transformed?JSON.stringify(result.data):text;}catch(error){publishStats({mode:"error",transport:"chromium-response-text",error:String(error&&error.message?error.message:error)});return text;}}});
  function requestSettings(){window.postMessage({channel:CHANNEL,type:"settings-request"},location.origin);} requestSettings();setTimeout(requestSettings,0);setTimeout(requestSettings,100);
})();
