"use strict";

/*
 * Genuine ChatGPT compatibility smoke test.
 *
 * Unlike the deterministic E2Es, this script never routes/intercepts requests
 * and never rewrites DNS. It talks to https://chatgpt.com directly, observes
 * the endpoint family the real site uses, then verifies that AntiCurse emitted
 * stats for that exact conversation document.
 *
 * Recommended read-only invocation:
 *   CHATGPT_SMOKE_URL='https://chatgpt.com/c/<conversation-id>' node tests/live-chatgpt-smoke.js
 *
 * To let a fresh anonymous session create a tiny throwaway conversation when
 * the home page is usable:
 *   CHATGPT_SMOKE_CREATE_ANON=1 node tests/live-chatgpt-smoke.js
 *
 * An existing browser profile may be supplied with CHATGPT_SMOKE_USER_DATA_DIR.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");
const ENDPOINT = require("../chrome/conversation-endpoint.js");

const CHATGPT_ORIGIN = "https://chatgpt.com";
const TARGET_URL = process.env.CHATGPT_SMOKE_URL || `${CHATGPT_ORIGIN}/`;
const CREATE_ANON = process.env.CHATGPT_SMOKE_CREATE_ANON === "1";
const REQUIRE_TRIM = process.env.CHATGPT_SMOKE_REQUIRE_TRIM === "1";
const HEADLESS = process.env.CHATGPT_SMOKE_HEADLESS !== "0";
const USER_DATA_DIR = process.env.CHATGPT_SMOKE_USER_DATA_DIR || null;
const NAV_TIMEOUT_MS = Math.max(10000, Number(process.env.CHATGPT_SMOKE_NAV_TIMEOUT_MS) || 60000);
const ENDPOINT_TIMEOUT_MS = Math.max(10000, Number(process.env.CHATGPT_SMOKE_ENDPOINT_TIMEOUT_MS) || 45000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exactConversationEndpoint(urlString) {
  const parsed = ENDPOINT.parse(urlString);
  if (!parsed) return null;
  const url = new URL(parsed.url);
  return {
    ...parsed,
    cursor: url.searchParams.get("cursor"),
    includeHasVersions: url.searchParams.get("include_has_versions"),
    numTurns: url.searchParams.get("num_turns")
  };
}

function isCloudflareChallenge(status, title) {
  return status === 403 || /just a moment|attention required/i.test(String(title || ""));
}

async function antiCurseWorker(context) {
  const matches = () => context.serviceWorkers().filter((worker) =>
    /^chrome-extension:\/\//.test(worker.url()) && /\/background-entry\.js(?:$|[?#])/.test(worker.url()));
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const worker = matches()[0];
    if (worker) {
      const ready = await worker.evaluate(() => !!(globalThis.chrome && chrome.runtime && chrome.tabs)).catch(() => false);
      if (ready) return worker;
    }
    await sleep(100);
  }
  throw new Error("AntiCurse extension service worker did not become ready");
}

async function contentMessageForPage(worker, page, message) {
  const pageUrl = page.url();
  return worker.evaluate(async ({ pageUrl, message }) => {
    const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    const tab = tabs.find((candidate) => candidate.url === pageUrl) || tabs[tabs.length - 1];
    if (!tab) return null;
    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (_) {
      return null;
    }
  }, { pageUrl, message });
}

async function statsForPage(worker, page) {
  return contentMessageForPage(worker, page, { type: "cg-get-stats" });
}

async function debugForPage(worker, page) {
  return contentMessageForPage(worker, page, { type: "cg-get-debug-state" });
}

async function debugForPage(worker, page) {
  const pageUrl = page.url();
  return worker.evaluate(async ({ pageUrl }) => {
    const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    const tab = tabs.find((candidate) => candidate.url === pageUrl) || tabs[tabs.length - 1];
    if (!tab) return null;
    try {
      return await chrome.tabs.sendMessage(tab.id, { type: "cg-get-debug-state" });
    } catch (_) {
      return null;
    }
  }, { pageUrl });
}

async function waitForStats(worker, page, endpoint) {
  const deadline = Date.now() + 10000;
  let last = null;
  while (Date.now() < deadline) {
    last = await statsForPage(worker, page);
    if (last && last.conversationId === endpoint.id) return last;
    await sleep(100);
  }
  throw new Error(`AntiCurse did not report interception stats for live conversation ${endpoint.id}; last=${JSON.stringify(last)}`);
}

async function createAnonymousConversation(page) {
  const composer = page.locator("#prompt-textarea, textarea, [contenteditable='true']").first();
  await composer.waitFor({ state: "visible", timeout: 15000 });
  const prompt = `AntiCurse live compatibility smoke ${Date.now()}: reply only OK.`;
  const tag = await composer.evaluate((element) => element.tagName.toLowerCase());
  if (tag === "textarea") await composer.fill(prompt);
  else {
    await composer.click();
    await page.keyboard.type(prompt);
  }
  await page.keyboard.press("Enter");
  await page.waitForURL(/https:\/\/chatgpt\.com\/c\/[^/?#]+/, { timeout: 30000 });
  // Creating a conversation normally uses a streaming POST. Reload so the
  // compatibility check necessarily exercises the real GET document endpoint.
  await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
}

(async () => {
  assert(/^https:\/\/chatgpt\.com(?:\/|$)/.test(TARGET_URL), "CHATGPT_SMOKE_URL must be on https://chatgpt.com");

  const extensionPath = path.resolve(__dirname, "..", "chrome");
  const temporaryProfile = !USER_DATA_DIR;
  const userDataDir = USER_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "anticurse-live-smoke-"));
  const observed = [];
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: HEADLESS,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  try {
    const workerPromise = antiCurseWorker(context);
    const page = await context.newPage();
    page.on("request", (request) => {
      if (request.method() !== "GET") return;
      const endpoint = exactConversationEndpoint(request.url());
      if (endpoint) observed.push({ phase: "request", ...endpoint });
    });
    page.on("response", (response) => {
      const endpoint = exactConversationEndpoint(response.url());
      if (endpoint) observed.push({ phase: "response", status: response.status(), ...endpoint });
    });

    const navigation = await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    const title = await page.title().catch(() => "");
    const status = navigation ? navigation.status() : null;
    if (isCloudflareChallenge(status, title)) {
      throw new Error(`live-site-blocked-by-cloudflare: status=${status} title=${JSON.stringify(title)}`);
    }
    if (/^\/auth\/login(?:\/|$)/.test(new URL(page.url()).pathname)) {
      throw new Error("live-site-auth-required: provide CHATGPT_SMOKE_USER_DATA_DIR with a copied authenticated Chromium profile, or use an accessible read-only conversation");
    }

    if (CREATE_ANON && !/\/c\/[^/?#]+/.test(new URL(page.url()).pathname)) {
      await createAnonymousConversation(page);
    }

    const worker = await workerPromise;
    const deadline = Date.now() + ENDPOINT_TIMEOUT_MS;
    let endpoint = null;
    while (Date.now() < deadline) {
      const successfulResponses = observed.filter((item) => item.phase === "response" && item.status >= 200 && item.status < 300 && !item.cursor);
      endpoint = successfulResponses[successfulResponses.length - 1] || null;
      if (endpoint) break;
      await sleep(100);
    }

    if (!endpoint) {
      throw new Error(
        `No successful real ChatGPT conversation-document GET was observed. ` +
        `Use CHATGPT_SMOKE_URL=https://chatgpt.com/c/<id> or CHATGPT_SMOKE_CREATE_ANON=1. observed=${JSON.stringify(observed)}`
      );
    }

    const stats = await waitForStats(worker, page, endpoint);
    assert.notEqual(stats.mode, "error", `AntiCurse recognized the live endpoint but rejected its response shape: ${JSON.stringify(stats)}`);
    assert(["trimmed", "passthrough"].includes(stats.mode), `unexpected AntiCurse live mode: ${JSON.stringify(stats)}`);

    let debug = await debugForPage(worker, page);
    if (REQUIRE_TRIM) {
      const debugDeadline = Date.now() + 10000;
      while (Date.now() < debugDeadline && !(debug?.ok && debug.state?.historyController?.historyPresent)) {
        await sleep(100);
        debug = await debugForPage(worker, page);
      }
      assert.equal(debug?.ok, true, `AntiCurse debug state unavailable: ${JSON.stringify(debug)}`);
      assert.equal(debug.state?.historyController?.nativeTrimConfirmed, true, "live long conversation was not confirmed trimmed");
      assert.equal(debug.state?.historyController?.historyPresent, true, "live long conversation did not expose private history");
      assert.equal(debug.state?.historyController?.historyConversationId, endpoint.id, "private history belongs to the wrong conversation");
      assert.equal(debug.state?.archiveBridge?.conversationConfirmed, true, "live network archive was not captured");
    }

    console.log(JSON.stringify({
      ok: true,
      pageUrl: page.url(),
      endpoint,
      antiCurse: {
        mode: stats.mode,
        reason: stats.reason || null,
        conversationId: stats.conversationId,
        paginationCursorSuppressed: !!stats.paginationCursorSuppressed,
        nativeTrimConfirmed: !!debug?.state?.historyController?.nativeTrimConfirmed,
        historyPresent: !!debug?.state?.historyController?.historyPresent,
        historyConversationId: debug?.state?.historyController?.historyConversationId || null,
        paginationCursorPreserved: !!debug?.state?.archiveBridge?.paginationCursorPreserved
      },
      observed
    }, null, 2));
    console.log("Live ChatGPT endpoint smoke: PASS");
  } finally {
    await context.close();
    if (temporaryProfile) fs.rmSync(userDataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
