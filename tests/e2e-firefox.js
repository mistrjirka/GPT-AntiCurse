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
  const chain = [];
  const seen = new Set();
  let id = full.current_node;
  while (id && full.mapping[id] && !seen.has(id)) {
    seen.add(id);
    const node = full.mapping[id];
    if (node.message) chain.push({ ...node.message, id });
    id = node.parent || null;
  }
  chain.reverse();
  // 10 raw records per exchange in this fixture. Keep the newest 40 exchanges
  // on the initial current ChatGPT page; the oldest 10 live behind `before`.
  const split = Math.max(0, chain.length - 400);
  return {
    first: {
      id: full.id, conversation_id: full.conversation_id, title: full.title,
      messages: chain.slice(split), current_node: full.current_node,
      page_info: { has_previous_page: true, start_cursor: "older-firefox-page" }
    },
    second: {
      id: full.id, conversation_id: full.conversation_id, title: full.title,
      messages: chain.slice(0, split), current_node: chain[split - 1]?.id || null,
      page_info: { has_previous_page: false, start_cursor: null }
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
  function normalizePaginated(raw){
    if(!raw||!Array.isArray(raw.messages)) return raw;
    const mapping={}; let parent=null;
    for(const message of raw.messages){
      if(!message||!message.id) continue;
      const id=message.id; mapping[id]={id,message,parent,children:[]};
      if(parent&&mapping[parent]) mapping[parent].children=[id];
      parent=id;
    }
    const current=raw.current_node&&mapping[raw.current_node]?raw.current_node:parent;
    return {...raw,mapping,current_node:current,root:null};
  }
  fetch('/backend-api/conversations/e2e-firefox?include_has_versions=true&num_turns=10').then(r=>r.json()).then(async raw=>{
    window.__receivedCursor=raw.page_info?.has_previous_page===true?(raw.page_info.start_cursor??null):null;
    window.__nativePaginationRequests=0;
    while(raw.page_info?.has_previous_page===true&&raw.page_info.start_cursor){
      window.__nativePaginationRequests++;
      const cursor=raw.page_info.start_cursor;
      const older=await fetch('/backend-api/conversations/e2e-firefox/messages?include_has_versions=true&num_turns=10&before='+encodeURIComponent(cursor)).then(r=>r.json());
      raw.messages=(older.messages||[]).concat(raw.messages||[]); raw.page_info=older.page_info||{};
    }
    const data=normalizePaginated(raw);
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
      if (req.headers.authorization) assert.equal(req.headers.authorization, "Bearer firefox-e2e-token");
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "singular endpoint retired" }));
      return;
    }
    if (url.pathname === "/backend-api/conversations/e2e-firefox") {
      if (req.headers.authorization) assert.equal(req.headers.authorization, "Bearer firefox-e2e-token");
      assert.equal(url.searchParams.get("include_has_versions"), "true");
      assert.equal(url.searchParams.get("num_turns"), "10");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(pages.first));
      return;
    }
    if (url.pathname === "/backend-api/conversations/e2e-firefox/messages") {
      assert.equal(req.headers.authorization || "", "Bearer firefox-e2e-token");
      assert.equal(url.searchParams.get("include_has_versions"), "true");
      assert.equal(url.searchParams.get("num_turns"), "10");
      assert.equal(url.searchParams.get("before"), "older-firefox-page");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(pages.second));
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
    assert.equal(state.cursor, "older-firefox-page", "Firefox newest page must preserve ChatGPT's real pagination cursor");
    assert.equal(state.nativePaginationRequests, 1, "Firefox native pagination may request one older page, which AntiCurse terminates before its records enter React");

    const button = await driver.wait(until.elementLocated(By.css("#cg-window-history-host .cg-history-previous")), 10000);
    assert.equal(await button.isDisplayed(), false, "fresh installs should default to Auto window without a manual history button");

    await driver.executeScript(`
      const root=document.querySelector('[data-scroll-root]');
      root.scrollTop=root.scrollHeight; root.dispatchEvent(new Event('scroll',{bubbles:true}));
      root.scrollTop=0; root.dispatchEvent(new Event('scroll',{bubbles:true}));
    `);
    await waitForValue(driver, "return document.querySelectorAll('#cg-window-history-host .cg-history-page').length > 0");

    const loaded = await driver.executeScript(`return {
      pages: document.querySelectorAll('#cg-window-history-host .cg-history-page').length,
      turns: document.querySelectorAll('#cg-window-history-host .cg-history-turn').length,
      nativeSyntheticAttrs: document.querySelectorAll('#cg-window-history-host [data-message-author-role], #cg-window-history-host [data-turn-id]').length
    }`);
    assert(loaded.pages >= 1 && loaded.pages <= 3);
    assert(loaded.turns > 0, "Auto window must render older archived turns after reaching the top");
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
