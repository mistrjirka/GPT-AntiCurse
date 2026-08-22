"use strict";

const assert = require("assert");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { Builder, By, until } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");

function makeNode(id, parent, role, metadata = {}) {
  return {
    id,
    parent,
    children: [],
    message: role ? {
      author: { role },
      content: { content_type: "text", parts: [id] },
      create_time: 1,
      metadata
    } : null
  };
}

function link(mapping, parent, child) {
  mapping[child].parent = parent;
  mapping[parent].children.push(child);
}

function conversation(exchanges = 50, assistantFragments = 4) {
  const mapping = { root: makeNode("root", null, null) };
  let parent = "root";
  for (let exchange = 0; exchange < exchanges; exchange++) {
    const user = `user-${exchange}`;
    mapping[user] = makeNode(user, parent, "user");
    link(mapping, parent, user);
    parent = user;

    const tool = `tool-${exchange}`;
    mapping[tool] = makeNode(tool, parent, "tool");
    link(mapping, parent, tool);
    parent = tool;

    const hidden = `hidden-${exchange}`;
    mapping[hidden] = makeNode(hidden, parent, "assistant", { is_visually_hidden_from_conversation: true });
    link(mapping, parent, hidden);
    parent = hidden;

    for (let fragment = 0; fragment < assistantFragments; fragment++) {
      const assistant = `assistant-${exchange}-${fragment}`;
      mapping[assistant] = makeNode(assistant, parent, "assistant");
      link(mapping, parent, assistant);
      parent = assistant;
      if (fragment < assistantFragments - 1) {
        const between = `tool-${exchange}-between-${fragment}`;
        mapping[between] = makeNode(between, parent, "tool");
        link(mapping, parent, between);
        parent = between;
      }
    }
  }
  return { id: "e2e-firefox", conversation_id: "e2e-firefox", title: "Firefox E2E", mapping, current_node: parent, root: "root" };
}

function paginatedConversationPages(full) {
  const entries = Object.entries(full.mapping);
  // Keep the newest 40 exchanges in the initial page so the normal Recent 64
  // trimming path is still exercised; the oldest 10 live behind the cursor.
  const split = Math.min(entries.length, 101);
  return {
    first: {
      id: full.id, conversation_id: full.conversation_id, title: full.title,
      mapping: Object.fromEntries(entries.slice(split)), current_node: full.current_node,
      root: full.root, cursor: "older-firefox-page"
    },
    second: {
      id: full.id, conversation_id: full.conversation_id, title: full.title,
      mapping: Object.fromEntries(entries.slice(0, split)), cursor: null
    }
  };
}

const FIXTURE_HTML = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
html,body{margin:0;height:100%;font-family:system-ui,sans-serif}[data-scroll-root]{height:600px;overflow-y:auto}#thread{min-height:700px}#thread section{padding:20px 32px;min-height:28px;border-bottom:1px solid rgba(0,0,0,.03)}
</style>
</head>
<body>
<script type="application/json" id="client-bootstrap">{"authStatus":"logged_in","session":{"accessToken":"firefox-bootstrap-token"}}</script>
<div data-scroll-root><div role="presentation" class="contents"><div id="thread"></div></div></div>
<script>
(() => {
  const root = document.querySelector('[data-scroll-root]');
  const thread = document.querySelector('#thread');
  function updateTopState(){ if(root.scrollTop>16) root.setAttribute('data-scroll-from-top',''); else root.removeAttribute('data-scroll-from-top'); }
  root.addEventListener('scroll', updateTopState);
  function hidden(node){ const m=node&&node.message&&node.message.metadata; return !!(m&&(m.is_visually_hidden_from_conversation===true||m.is_user_system_message===true)); }
  function role(node){ return node&&node.message&&node.message.author&&node.message.author.role; }
  function chain(data){ const r=[],s=new Set(); let id=data.current_node; while(id&&data.mapping[id]&&!s.has(id)){s.add(id);r.push(id);id=data.mapping[id].parent||null;} return r.reverse(); }
  fetch('/backend-api/conversation/e2e-firefox').then(r=>r.json()).then(async data=>{
    window.__receivedCursor=data.cursor??null;
    window.__nativePaginationRequests=0;
    while(data.cursor){
      window.__nativePaginationRequests++;
      const older=await fetch('/backend-api/conversation/e2e-firefox?cursor='+encodeURIComponent(data.cursor)).then(r=>r.json());
      Object.assign(data.mapping,older.mapping||{}); data.cursor=older.cursor??null;
    }
    window.__receivedConversation=data;
    window.__receivedMappingNodes=Object.keys(data.mapping).length;
    let visible=0;
    for(const id of chain(data)){
      const node=data.mapping[id], r=role(node);
      if(hidden(node)||(r!=='user'&&r!=='assistant')) continue;
      visible++;
      const section=document.createElement('section'); section.setAttribute('data-testid','conversation-turn-'+visible);
      const message=document.createElement('div'); message.setAttribute('data-message-author-role',r); message.textContent=node.message.content.parts.join('\n');
      section.append(message); thread.append(section);
    }
    window.__nativeVisible=visible; window.__ready=true;
    root.scrollTop=root.scrollHeight; updateTopState(); root.dispatchEvent(new Event('scroll',{bubbles:true}));
  }).catch(error=>{ window.__fixtureError=String(error&&error.stack||error); });
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
  const pages = paginatedConversationPages(fullConversation);
  return https.createServer(tls, (req, res) => {
    const url = new URL(req.url, "https://chatgpt.com:8443");
    if (url.pathname === "/c/e2e-firefox") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FIXTURE_HTML);
      return;
    }
    if (url.pathname === "/api/auth/session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accessToken: "firefox-e2e-token" }));
      return;
    }
    if (url.pathname === "/backend-api/conversation/e2e-firefox") {
      const auth = req.headers.authorization || "";
      const cursor = url.searchParams.get("cursor");
      if (auth) assert.equal(auth, "Bearer firefox-e2e-token");
      if (cursor) assert.equal(cursor, "older-firefox-page");
      const body = cursor ? pages.second : pages.first;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "anticurse-firefox-e2e-"));
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
    assert.equal(typeof driver.installAddon, "function", "Firefox WebDriver must expose temporary addon installation");
    const addonId = await driver.installAddon(xpi, true);
    assert(addonId, "temporary Firefox addon should install");

    await driver.get("https://chatgpt.com:8443/c/e2e-firefox");
    await waitForValue(driver, "return window.__ready === true || !!window.__fixtureError");
    const fixtureError = await driver.executeScript("return window.__fixtureError || null");
    assert.equal(fixtureError, null, fixtureError || "Firefox fixture failed");

    const state = await driver.executeScript(`return {
      visible: window.__nativeVisible,
      nodes: window.__receivedMappingNodes,
      hasOldUser: !!window.__receivedConversation.mapping['user-17'],
      hasCutoffUser: !!window.__receivedConversation.mapping['user-18'],
      hasRecentTool: !!window.__receivedConversation.mapping['tool-18'],
      hasRecentHidden: !!window.__receivedConversation.mapping['hidden-18'],
      cursor: window.__receivedCursor,
      nativePaginationRequests: window.__nativePaginationRequests
    }`);
    console.log("Firefox trim state", JSON.stringify({ addonId, ...state }));

    // Default N=64 logical units = the last 32 complete user/assistant exchanges.
    assert.equal(state.visible, 160, "Firefox should receive 32 exchanges = 160 raw visible records");
    assert(state.nodes < 390, `Firefox page graph should be bounded, got ${state.nodes}`);
    assert.equal(state.hasOldUser, false, "older graph state must be filtered before Firefox page code receives it");
    assert.equal(state.hasCutoffUser, true, "logical cutoff must retain first recent Firefox exchange");
    assert.equal(state.hasRecentTool, true, "recent Firefox technical nodes must survive");
    assert.equal(state.hasRecentHidden, true, "recent Firefox hidden nodes must survive");
    assert.equal(state.cursor, null, "Firefox pagination firewall must terminate the native cursor before page code sees it");
    assert.equal(state.nativePaginationRequests, 0, "Firefox page code must not fetch raw older cursor pages");

    const button = await driver.wait(until.elementLocated(By.css("#cg-window-history-host .cg-history-previous")), 10000);
    await driver.wait(until.elementIsVisible(button), 10000);
    assert.equal(await button.getText(), "Load previous 36", "only 36 older logical turns remain in this fixture");

    const marker = await driver.findElement(By.css("#cg-window-history-host .cg-history-marker"));
    assert((await marker.getText()).includes("36 older turns available"));
    await button.click();
    await driver.sleep(80);

    const loaded = await driver.executeScript(`return {
      marker: document.querySelector('#cg-window-history-host .cg-history-marker').textContent,
      pages: document.querySelectorAll('#cg-window-history-host .cg-history-page').length,
      nativeSyntheticAttrs: document.querySelectorAll('#cg-window-history-host [data-message-author-role], #cg-window-history-host [data-turn-id]').length
    }`);
    assert(loaded.marker.includes("36 older turns loaded"));
    assert(loaded.pages >= 1 && loaded.pages <= 3);
    assert.equal(loaded.nativeSyntheticAttrs, 0);

    console.log("Firefox extension E2E: PASS", JSON.stringify({ addonId, ...state, ...loaded }));
  } finally {
    await driver.quit().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
