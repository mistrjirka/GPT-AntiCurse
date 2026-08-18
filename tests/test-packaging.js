"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const STANDARD_ICON_CHUNKS = new Set(["IHDR", "IDAT", "IEND"]);

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

function manifestIconPaths(manifest) {
  const paths = new Set(Object.values(manifest.icons || {}));
  const toolbar = manifest.action && manifest.action.default_icon;
  if (typeof toolbar === "string") paths.add(toolbar);
  else if (toolbar && typeof toolbar === "object") {
    for (const name of Object.values(toolbar)) paths.add(name);
  }
  return paths;
}

function pngChunks(buffer) {
  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const next = offset + 12 + length;
    assert(next <= buffer.length, `PNG chunk ${type} exceeds file bounds`);
    chunks.push(type);
    offset = next;
    if (type === "IEND") break;
  }
  assert.equal(offset, buffer.length, "PNG must end immediately after IEND");
  return chunks;
}

function validatePngIcon(file, expectedSize) {
  const buffer = fs.readFileSync(file);
  assert(buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), `${file}: invalid PNG signature`);
  assert.equal(buffer.readUInt32BE(8), 13, `${file}: IHDR must have the standard 13-byte payload`);
  assert.equal(buffer.toString("ascii", 12, 16), "IHDR", `${file}: first PNG chunk must be IHDR`);
  assert.equal(buffer.readUInt32BE(16), expectedSize, `${file}: wrong PNG width`);
  assert.equal(buffer.readUInt32BE(20), expectedSize, `${file}: wrong PNG height`);
  assert.equal(buffer[24], 8, `${file}: icon must use 8-bit channels`);
  assert.equal(buffer[25], 6, `${file}: icon must use standard RGBA color type`);
  assert.equal(buffer[26], 0, `${file}: unsupported PNG compression method`);
  assert.equal(buffer[27], 0, `${file}: unsupported PNG filter method`);
  assert.equal(buffer[28], 0, `${file}: icon must be non-interlaced`);

  const chunks = pngChunks(buffer);
  assert.equal(chunks[0], "IHDR", `${file}: first chunk must be IHDR`);
  assert.equal(chunks.at(-1), "IEND", `${file}: last chunk must be IEND`);
  assert(chunks.includes("IDAT"), `${file}: PNG must contain image data`);
  assert(chunks.every((type) => STANDARD_ICON_CHUNKS.has(type)), `${file}: unexpected PNG metadata/chunk: ${chunks.join(", ")}`);
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

  assert(manifest.icons && manifest.icons["128"], `${browser}: 128px extension icon is not declared`);
  assert(manifest.action && manifest.action.default_icon, `${browser}: toolbar icon is not declared`);
  for (const name of manifestIconPaths(manifest)) {
    assert(fs.existsSync(path.join(dir, name)), `${browser}: referenced icon file is missing: ${name}`);
  }
  for (const [size, name] of Object.entries(manifest.icons || {})) {
    validatePngIcon(path.join(dir, name), Number(size));
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
console.log("packaging reachability and icon PNG validation: PASS", JSON.stringify(results));
