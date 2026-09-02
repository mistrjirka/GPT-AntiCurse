"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// Firefox WebDriver cannot directly enter a temporary extension's storage.local
// context on current stable Firefox. For E2Es that exercise the opt-in
// Performance Guard path, build a throwaway package whose only difference is
// the fresh-install default. Production defaults remain covered separately by
// test-settings-defaults.js.
function buildFirefoxE2eXpi({ sourceDir, tempDir, xpiPath, performanceGuardEnabled = false }) {
  const extensionDir = path.join(tempDir, "firefox-e2e-extension");
  fs.cpSync(sourceDir, extensionDir, { recursive: true });

  if (performanceGuardEnabled) {
    const replacements = [
      ["background.js", "const DEFAULT_SETTINGS = {\n  enabled: false,", "const DEFAULT_SETTINGS = {\n  enabled: true,"],
      ["content.js", "browser.storage.local.get({ enabled: false,", "browser.storage.local.get({ enabled: true,"],
      ["windowed.js", "const DEFAULT_SETTINGS = Object.freeze({ enabled: false,", "const DEFAULT_SETTINGS = Object.freeze({ enabled: true,"]
    ];
    for (const [file, from, to] of replacements) {
      const target = path.join(extensionDir, file);
      const source = fs.readFileSync(target, "utf8");
      assert(source.includes(from), `${file}: expected production Performance Guard default marker`);
      fs.writeFileSync(target, source.replace(from, to));
    }
  }

  execFileSync("zip", ["-qr", xpiPath, "."], { cwd: extensionDir });
  return extensionDir;
}

module.exports = { buildFirefoxE2eXpi };
