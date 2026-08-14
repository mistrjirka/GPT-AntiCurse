"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function text(file) {
  return fs.readFileSync(file, "utf8");
}

function filesWithExtension(dir, extension) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(extension))
    .sort();
}

function htmlAssets(html, tag, attribute, extension) {
  const result = [];
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attribute}=["']([^"']+${extension.replace(".", "\\.")})["']`, "gi");
  let match;
  while ((match = re.exec(html))) result.push(match[1]);
  return result;
}

function importedScripts(source) {
  const result = [];
  const call = /importScripts\s*\(([^)]*)\)/g;
  let match;
  while ((match = call.exec(source))) {
    const args = match[1];
    const string = /["']([^"']+\.js)["']/g;
    let item;
    while ((item = string.exec(args))) result.push(item[1]);
  }
  return result;
}

function checkBrowser(browser) {
  const dir = path.join(ROOT, browser);
  const manifest = JSON.parse(text(path.join(dir, "manifest.json")));
  const jsReachable = new Set();
  const cssReachable = new Set();
  const queue = [];

  function addJs(name) {
    if (!name || jsReachable.has(name)) return;
    jsReachable.add(name);
    queue.push(name);
  }

  for (const entry of manifest.content_scripts || []) {
    for (const name of entry.js || []) addJs(name);
    for (const name of entry.css || []) cssReachable.add(name);
  }

  if (manifest.background) {
    if (manifest.background.service_worker) addJs(manifest.background.service_worker);
    for (const name of manifest.background.scripts || []) addJs(name);
  }

  const popupName = manifest.action && manifest.action.default_popup;
  if (popupName) {
    const popupPath = path.join(dir, popupName);
    assert(fs.existsSync(popupPath), `${browser}: popup ${popupName} is missing`);
    const popup = text(popupPath);
    for (const name of htmlAssets(popup, "script", "src", ".js")) addJs(name);
    for (const name of htmlAssets(popup, "link", "href", ".css")) cssReachable.add(name);
  }

  while (queue.length) {
    const name = queue.shift();
    const file = path.join(dir, name);
    assert(fs.existsSync(file), `${browser}: referenced JavaScript file is missing: ${name}`);
    for (const imported of importedScripts(text(file))) addJs(imported);
  }

  for (const name of cssReachable) {
    assert(fs.existsSync(path.join(dir, name)), `${browser}: referenced CSS file is missing: ${name}`);
  }

  const packagedJs = filesWithExtension(dir, ".js");
  const packagedCss = filesWithExtension(dir, ".css");
  const deadJs = packagedJs.filter((name) => !jsReachable.has(name));
  const deadCss = packagedCss.filter((name) => !cssReachable.has(name));

  assert.deepEqual(deadJs, [], `${browser}: unreachable JavaScript is still packaged: ${deadJs.join(", ")}`);
  assert.deepEqual(deadCss, [], `${browser}: unreachable CSS is still packaged: ${deadCss.join(", ")}`);

  return { browser, js: packagedJs.length, css: packagedCss.length };
}

const results = [checkBrowser("chrome"), checkBrowser("firefox")];
console.log("packaging reachability: PASS", JSON.stringify(results));
