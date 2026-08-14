"use strict";

const assert = require("assert");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { Builder, By, until } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");

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

function conversation(exchanges = 36) {
  const mapping = { root: node("root", null, null, "") };
  let parent = "root";

  for (let exchange = 0; exchange < exchanges; exchange++) {
    const user = `user-${exchange}`;
    mapping[user] = node(user, parent, "user", `User message ${exchange}`);
    link(mapping, parent, user);
    parent = user;

    const fragments = exchange === 2
      ? [
          "Archived assistant narration before the tool.",
          JSON.stringify({
            path: "/asdk_app_firefox_fidelity/link_fidelity/exec_command",
            args: { session_id: "s_firefox_fidelity", command: "echo firefox-fidelity-secret" }
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
    id: "firefox-fidelity-e2e",
    conversation_id: "firefox-fidelity-e2e",
    title: "Firefox Fidelity E2E",
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
.native-user-bubble{max-width:70%;border-radius:22px;padding:10px 16px;background:#ececec}
.native-user-text{white-space:pre-wrap}
.native-activity-marker{width:100%}
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
    if(r==='assistant'&&index===2){
      const activity=document.createElement('div');
      activity.className='native-activity-marker text-token-text-tertiary flex items-start gap-2 text-start text-base leading-6';
      const icon=document.createElement('span');
      icon.setAttribute('data-testid','cot-v5-tool-icon-pile');
      activity.append(icon,document.createTextNode('Native activity row'));
      grow.append(activity);
    }
    const message=document.createElement('div');
    message.className='native-message-marker min-h-8 text-message relative flex w-full flex-col items-end gap-2 text-start break-words whitespace-normal';
    message.setAttribute('data-message-author-role',r);
    if(r==='user'){
      const body=document.createElement('div'); body.className='native-user-body flex w-full flex-col gap-1 items-end';
      const bubble=document.createElement('div'); bubble.className='native-user-bubble user-message-bubble-color max-w-(--user-chat-width,70%)';
      const inner=document.createElement('div'); inner.className='native-user-text max-w-full min-w-0 whitespace-pre-wrap'; inner.textContent=text;
      bubble.append(inner); body.append(bubble); message.append(body);
    } else {
      const body=document.createElement('div'); body.className='native-assistant-body flex w-full flex-col gap-1';
      const md=document.createElement('div'); md.className='native-markdown markdown prose dark:prose-invert wrap-break-word w-full dark markdown-new-styling'; md.textContent=text;
      body.append(md); message.append(body);
    }
    grow.append(message); group.append(grow); outer.append(group); section.append(outer); thread.append(section);
  }
  function topState(){if(root.scrollTop>16)root.setAttribute('data-scroll-from-top','');else root.removeAttribute('data-scroll-from-top')}
  root.addEventListener('scroll',topState);
  fetch('/backend-api/conversation/firefox-fidelity-e2e').then(r=>r.json()).then(data=>{
    window.__receivedMappingNodes=Object.keys(data.mapping).length;
    let visible=0;
    for(const id of chain(data)){
      const n=data.mapping[id],r=role(n);
      if(hidden(n)||(r!=='user'&&r!=='assistant'))continue;
      visible++;
      nativeTurn(r,n.message.content.parts.join('\n'),visible);
    }
    window.__nativeVisible=visible;
    window.__ready=true;
    root.scrollTop=root.scrollHeight;topState();root.dispatchEvent(new Event('scroll',{bubbles:true}));
  }).catch(e=>window.__fixtureError=String(e&&e.stack||e));
})();
</script>
</body>
</html>`;

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

function createServer(tls, fullConversation) {
  return https.createServer(tls, (req, res) => {
    if (req.url === "/c/firefox-fidelity-e2e") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FIXTURE);
      return;
    }
    if (req.url === "/backend-api/conversation/firefox-fidelity-e2e") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(fullConversation));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
}

async function waitForValue(driver, script, timeout = 12000) {
  await driver.wait(async () => {
    try { return !!(await driver.executeScript(script)); } catch (_) { return false; }
  }, timeout);
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "anticurse-firefox-fidelity-e2e-"));
  const xpi = path.join(temp, "gpt-anticurse-firefox.xpi");
  const extensionDir = path.resolve(__dirname, "..", "firefox");
  execFileSync("zip", ["-qr", xpi, "."], { cwd: extensionDir });

  const fullConversation = conversation();
  const server = createServer(createCertificate(temp), fullConversation);
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

  const driver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .build();

  try {
    const addonId = await driver.installAddon(xpi, true);
    assert(addonId, "temporary Firefox addon should install");

    await driver.get("https://chatgpt.com:8443/c/firefox-fidelity-e2e");
    await waitForValue(driver, "return window.__ready === true || !!window.__fixtureError");
    assert.equal(await driver.executeScript("return window.__fixtureError || null"), null, "Firefox fidelity fixture failed");

    const nativeState = await driver.executeScript(`return {
      visible: window.__nativeVisible,
      nodes: window.__receivedMappingNodes,
      nativeWidth: document.querySelector('#thread .native-group-marker')?.getBoundingClientRect().width || 0
    }`);
    assert.equal(nativeState.visible, 128, "default Recent 64 logical units should retain 32 exchanges / 128 raw visible records");
    assert(nativeState.nodes < Object.keys(fullConversation.mapping).length, "Firefox response filter must trim before the page renders");

    const button = await driver.wait(until.elementLocated(By.css("#cg-window-history-host .cg-history-previous")), 10000);
    await driver.wait(until.elementIsVisible(button), 10000);
    assert.equal(await button.getText(), "Load previous 8", "four archived exchanges should equal eight logical turns");
    await button.click();
    await waitForValue(driver, "return document.querySelectorAll('#cg-window-history-host .cg-history-turn').length > 0");

    const result = await driver.executeScript(`
      const host=document.querySelector('#cg-window-history-host');
      const archivedAssistant=host.querySelector('.cg-history-turn[data-cg-role="assistant"]');
      const group=archivedAssistant&&archivedAssistant.querySelector('.cg-history-turn-width');
      const outer=archivedAssistant&&archivedAssistant.querySelector('.cg-history-turn-outer');
      const activity=host.querySelector('.cg-history-activity');
      return {
        fidelity: archivedAssistant&&archivedAssistant.getAttribute('data-cg-fidelity'),
        groupClass: group&&group.className,
        outerClass: outer&&outer.className,
        nativeWidth: document.querySelector('#thread .native-group-marker')?.getBoundingClientRect().width || 0,
        archivedWidth: group&&group.getBoundingClientRect().width,
        activityClass: activity&&activity.className,
        activityText: activity&&activity.textContent,
        activityTitle: activity&&activity.title,
        text: host.textContent,
        nativeIdentityAttrs: host.querySelectorAll('[data-message-author-role],[data-turn-id]').length
      };
    `);

    assert.equal(result.fidelity, "native-v1", "Firefox archived turn must pass through native fidelity transformation");
    assert(result.groupClass.includes("native-group-marker"), `Firefox archive must inherit live native group classes: ${result.groupClass}`);
    assert(result.outerClass.includes("native-outer-marker"), `Firefox archive must inherit live native outer classes: ${result.outerClass}`);
    assert(Math.abs(result.nativeWidth - result.archivedWidth) < 1.5, `Firefox archived/native widths should match: ${JSON.stringify(result)}`);
    assert(result.activityClass.includes("native-activity-marker"), `Firefox archive should inherit live activity-row class: ${result.activityClass}`);
    assert(result.activityText && result.activityText.includes("Development Sandbox"), `legacy Firefox tool call should become compact activity: ${JSON.stringify(result)}`);
    assert(result.activityTitle.includes("firefox-fidelity-secret"), "raw Firefox tool payload must remain inspectable in title");
    assert(!result.text.includes("firefox-fidelity-secret"), "raw Firefox tool payload must not occupy visible transcript text");
    assert(!result.text.includes("[Non-text visible message]"), "legacy Firefox non-text placeholder must be suppressed");
    assert.equal(result.nativeIdentityAttrs, 0, "Firefox synthetic archive must not impersonate React-owned messages");

    console.log("Firefox native-fidelity E2E: PASS", JSON.stringify({ addonId, ...nativeState, ...result }));
  } finally {
    await driver.quit().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
