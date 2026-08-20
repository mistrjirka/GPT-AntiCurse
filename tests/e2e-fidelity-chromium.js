"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

function node(id, parent, role, text) {
  return {
    id,
    parent,
    children: [],
    message: role ? {
      author: { role },
      content: { content_type: "text", parts: [text == null ? id : text] },
      create_time: 1,
      metadata: {}
    } : null
  };
}

function link(mapping, parent, child) {
  mapping[parent].children.push(child);
  mapping[child].parent = parent;
}

function conversation() {
  const mapping = { root: node("root", null, null, "") };
  let parent = "root";
  for (let exchange = 0; exchange < 6; exchange++) {
    const user = `user-${exchange}`;
    mapping[user] = node(user, parent, "user", `User message ${exchange}`);
    link(mapping, parent, user);
    parent = user;

    const fragments = exchange === 3
      ? [
          "Archived assistant narration before the tool.",
          JSON.stringify({
            path: "/asdk_app_fidelity/link_fidelity/exec_command",
            args: { session_id: "s_fidelity", command: "echo fidelity-secret" }
          }),
          JSON.stringify({
            system2_search_query: [{ q: "fidelity-web-secret" }],
            response_length: "short"
          }),
          "[Non-text visible message]"
        ]
      : [
          `Assistant ${exchange} progress A`,
          `Assistant ${exchange} progress B`,
          `Assistant ${exchange} final answer`
        ];

    for (let fragment = 0; fragment < fragments.length; fragment++) {
      const assistant = `assistant-${exchange}-${fragment}`;
      mapping[assistant] = node(assistant, parent, "assistant", fragments[fragment]);
      link(mapping, parent, assistant);
      parent = assistant;
    }
  }
  return {
    id: "fidelity-e2e",
    conversation_id: "fidelity-e2e",
    title: "Fidelity E2E",
    mapping,
    current_node: parent,
    root: "root"
  };
}

const FIXTURE = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
html,body{margin:0;height:100%;font-family:system-ui,sans-serif}
[data-scroll-root]{height:720px;overflow-y:auto}
#thread{min-height:900px}
.native-section-marker{width:100%}
.native-outer-marker{--thread-content-margin:37px;padding-inline:var(--thread-content-margin)}
.native-group-marker{--thread-content-max-width:731px;max-width:var(--thread-content-max-width);margin-inline:auto;width:100%}
.native-grow-marker{display:flex;max-width:100%;flex-direction:column;gap:16px}
.native-message-marker{display:flex;width:100%;flex-direction:column;align-items:flex-end}
.native-assistant-body{display:flex;width:100%;flex-direction:column;gap:4px}
.native-markdown{width:100%;line-height:24px}
.native-user-body{display:flex;width:100%;flex-direction:column;align-items:flex-end}
.native-user-attachment{width:120px;height:24px}
.native-user-bubble{max-width:70%;border-radius:22px;padding:10px 16px;background:#ececec}
.native-user-text{white-space:pre-wrap}
</style>
</head>
<body>
<div data-scroll-root><div role="presentation" class="contents"><div id="thread"></div></div></div>
<script>
(() => {
  const root=document.querySelector('[data-scroll-root]');
  const thread=document.querySelector('#thread');
  const hidden=(n)=>!!(n&&n.message&&n.message.metadata&&(n.message.metadata.is_visually_hidden_from_conversation||n.message.metadata.is_user_system_message));
  const role=(n)=>n&&n.message&&n.message.author&&n.message.author.role;
  function chain(data){const out=[],seen=new Set();let id=data.current_node;while(id&&data.mapping[id]&&!seen.has(id)){seen.add(id);out.push(id);id=data.mapping[id].parent||null}return out.reverse()}
  function nativeTurn(r,text,index){
    const section=document.createElement('section');
    section.className='native-section-marker text-token-text-primary w-full focus:outline-none';
    section.setAttribute('data-testid','conversation-turn-'+index);
    const outer=document.createElement('div');
    outer.className='native-outer-marker text-base my-auto mx-auto';
    const group=document.createElement('div');
    group.className='native-group-marker group/turn-messages relative flex w-full min-w-0 flex-col'+(r==='assistant'?' agent-turn':'');
    const grow=document.createElement('div');
    grow.className='native-grow-marker flex max-w-full flex-col gap-4 grow';
    const message=document.createElement('div');
    message.className='native-message-marker min-h-8 text-message relative flex w-full flex-col items-end gap-2 text-start break-words whitespace-normal';
    message.setAttribute('data-message-author-role',r);
    if(r==='user'){
      const body=document.createElement('div'); body.className='native-user-body flex w-full flex-col gap-1 items-end';
      // Deliberately put a non-text attachment row first. The fidelity sampler must
      // find the actual text bubble rather than assuming body.firstElementChild.
      const attachment=document.createElement('div'); attachment.className='native-user-attachment flex flex-row items-center justify-end gap-1 max-w-72'; attachment.textContent='attachment preview';
      const bubble=document.createElement('div'); bubble.className='native-user-bubble user-message-bubble-color max-w-(--user-chat-width,70%) leading-6 rounded-[22px]';
      const inner=document.createElement('div'); inner.className='native-user-text max-w-full min-w-0 whitespace-pre-wrap'; inner.textContent=text;
      bubble.append(inner); body.append(attachment,bubble); message.append(body);
    } else {
      const body=document.createElement('div'); body.className='native-assistant-body flex w-full flex-col gap-1';
      const md=document.createElement('div'); md.className='native-markdown markdown prose dark:prose-invert wrap-break-word w-full dark markdown-new-styling'; md.textContent=text;
      body.append(md); message.append(body);
    }
    grow.append(message); group.append(grow); outer.append(group); section.append(outer); thread.append(section);
  }
  function topState(){if(root.scrollTop>16)root.setAttribute('data-scroll-from-top','');else root.removeAttribute('data-scroll-from-top')}
  root.addEventListener('scroll',topState);
  fetch('/backend-api/conversation/fidelity-e2e').then(r=>r.json()).then(data=>{
    let visible=0;
    for(const id of chain(data)){
      const n=data.mapping[id],r=role(n);
      if(hidden(n)||(r!=='user'&&r!=='assistant'))continue;
      visible++;
      nativeTurn(r,n.message.content.parts.join('\n'),visible);
    }
    window.__ready=true;
    root.scrollTop=root.scrollHeight;topState();root.dispatchEvent(new Event('scroll',{bubbles:true}));
  }).catch(e=>window.__fixtureError=String(e&&e.stack||e));
})();
</script>
</body>
</html>`;

async function worker(context) {
  return context.serviceWorkers()[0] || context.waitForEvent("serviceworker");
}

(async () => {
  const extensionPath = path.resolve(__dirname, "..", "chrome");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "anticurse-fidelity-e2e-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });

  try {
    await context.route("https://chatgpt.com/c/fidelity-e2e", route => route.fulfill({ status: 200, contentType: "text/html", body: FIXTURE }));
    await context.route("https://chatgpt.com/backend-api/conversation/fidelity-e2e", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(conversation()) }));

    const serviceWorker = await worker(context);
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ enabled: true, mode: "recent", maxDisplayMessages: 4, showGuardNotice: false });
    });

    const page = await context.newPage();
    await page.goto("https://chatgpt.com/c/fidelity-e2e", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ready || window.__fixtureError);
    assert.equal(await page.evaluate(() => window.__fixtureError || null), null);

    const button = page.locator("#cg-window-history-host .cg-history-previous");
    await button.waitFor({ state: "visible" });
    assert.equal(await button.textContent(), "Load previous 4");
    await button.click();
    await page.waitForFunction(() => document.querySelectorAll("#cg-window-history-host .cg-history-turn").length > 0);

    const result = await page.evaluate(() => {
      const host=document.querySelector('#cg-window-history-host');
      const archivedAssistant=host.querySelector('.cg-history-turn[data-cg-role="assistant"]');
      const archivedUser=host.querySelector('.cg-history-turn[data-cg-role="user"]');
      const group=archivedAssistant&&archivedAssistant.querySelector('.cg-history-turn-width');
      const outer=archivedAssistant&&archivedAssistant.querySelector('.cg-history-turn-outer');
      const userBubble=archivedUser&&archivedUser.querySelector('.cg-history-user-bubble');
      const userText=userBubble&&userBubble.firstElementChild;
      const nativeGroup=document.querySelector('#thread .native-group-marker');
      const activity=host.querySelector('.cg-history-activity');
      return {
        fidelity: archivedAssistant&&archivedAssistant.getAttribute('data-cg-fidelity'),
        groupClass: group&&group.className,
        outerClass: outer&&outer.className,
        userBubbleClass: userBubble&&userBubble.className,
        userTextClass: userText&&userText.className,
        nativeWidth: nativeGroup&&nativeGroup.getBoundingClientRect().width,
        archivedWidth: group&&group.getBoundingClientRect().width,
        activityText: activity&&activity.textContent,
        activityTitle: activity&&activity.title,
        text: host.textContent,
        nativeIdentityAttrs: host.querySelectorAll('[data-message-author-role],[data-turn-id]').length
      };
    });

    assert.equal(result.fidelity, "native-v1", "archived turn must pass through native fidelity transformation");
    assert(result.groupClass.includes("native-group-marker"), `archived group must inherit live native group classes: ${result.groupClass}`);
    assert(result.outerClass.includes("native-outer-marker"), `archived outer shell must inherit live native margin classes: ${result.outerClass}`);
    assert(result.userBubbleClass.includes("native-user-bubble"), `archived user text must inherit the actual native text bubble, not an attachment row: ${result.userBubbleClass}`);
    assert(!result.userBubbleClass.includes("native-user-attachment"), `attachment row must never be sampled as the user bubble: ${result.userBubbleClass}`);
    assert(result.userTextClass.includes("native-user-text"), `archived user text must inherit the native text node classes: ${result.userTextClass}`);
    assert(Math.abs(result.nativeWidth - result.archivedWidth) < 1.5, `archived/native widths should match: ${JSON.stringify(result)}`);
    assert(result.activityText && result.activityText.includes("Development Sandbox"), `legacy tool call should become compact activity: ${JSON.stringify(result)}`);
    assert(result.activityTitle.includes("fidelity-secret"), "raw tool payload must remain inspectable in title");
    assert(result.text.includes("Searched the web"), "provider-specific serialized search payload should become a compact activity row");
    assert(!result.text.includes("fidelity-secret"), "raw tool payload must not occupy the visible transcript");
    assert(!result.text.includes("fidelity-web-secret"), "raw web-search payload must not occupy the visible transcript");
    assert(!result.text.includes("[Non-text visible message]"), "legacy placeholder must be suppressed");
    assert.equal(result.nativeIdentityAttrs, 0, "synthetic archived history must not impersonate React-owned messages");

    console.log("Chromium native-fidelity E2E: PASS", JSON.stringify(result));
    await page.close();
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
