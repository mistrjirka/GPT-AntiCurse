/* Editor-aware synthetic input for ChatGPT's controlled ProseMirror composer. */
(() => {
  "use strict";

  const COMPOSER_SELECTOR = '#prompt-textarea[contenteditable="true"]';
  let nativeInsertSuccesses = 0;
  let fallbackInsertSuccesses = 0;
  let clearSuccesses = 0;
  let failures = 0;
  let lastMethod = null;

  function composer() {
    return document.querySelector(COMPOSER_SELECTOR);
  }

  function text(node = composer()) {
    return node ? String(node.textContent || "").trim() : "";
  }

  function containsOnlyNudge(node = composer()) {
    return !!node && text(node) === ".";
  }

  function focus(node) {
    if (!node || !node.isConnected) return false;
    try { node.focus({ preventScroll: true }); }
    catch { try { node.focus(); } catch { return false; } }
    return true;
  }

  function selectContents(node, collapseToEnd) {
    try {
      const selection = window.getSelection();
      if (!selection) return false;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (collapseToEnd) range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch {
      return false;
    }
  }

  function nativeInsert(node, value) {
    if (!focus(node) || !selectContents(node, true)) return false;
    try {
      if (typeof document.execCommand !== "function") return false;
      const accepted = document.execCommand("insertText", false, value);
      return accepted !== false && text(node) === value;
    } catch {
      return false;
    }
  }

  function fallbackInsert(node, value) {
    if (!focus(node)) return false;
    const before = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: value
    });
    if (!node.dispatchEvent(before)) return false;
    const paragraph = document.createElement("p");
    paragraph.textContent = value;
    node.replaceChildren(paragraph);
    node.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value
    }));
    return text(node) === value;
  }

  function insertNudge(node = composer()) {
    if (!node || !node.isConnected || text(node)) {
      failures++;
      lastMethod = "insert-precondition";
      return false;
    }

    if (nativeInsert(node, ".")) {
      nativeInsertSuccesses++;
      lastMethod = "execCommand-insertText";
      return true;
    }

    if (fallbackInsert(node, ".")) {
      fallbackInsertSuccesses++;
      lastMethod = "input-event-fallback";
      return true;
    }

    failures++;
    lastMethod = "insert-failed";
    return false;
  }

  function nativeClear(node) {
    if (!focus(node) || !selectContents(node, false)) return false;
    try {
      if (typeof document.execCommand !== "function") return false;
      document.execCommand("delete", false, null);
      return !text(node);
    } catch {
      return false;
    }
  }

  function fallbackClear(node) {
    if (!focus(node)) return false;
    const before = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
      data: null
    });
    if (!node.dispatchEvent(before)) return false;
    node.replaceChildren();
    node.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "deleteContentBackward",
      data: null
    }));
    return !text(node);
  }

  function clearNudge(node = composer()) {
    if (!node || !node.isConnected || !containsOnlyNudge(node)) return false;
    if (nativeClear(node) || fallbackClear(node)) {
      clearSuccesses++;
      lastMethod = "clear";
      return true;
    }
    failures++;
    lastMethod = "clear-failed";
    return false;
  }

  globalThis.CGAntiCurseComposerInput = {
    composer,
    text,
    containsOnlyNudge,
    insertNudge,
    clearNudge,
    debug() {
      return {
        present: true,
        composerPresent: !!composer(),
        containsOnlyNudge: containsOnlyNudge(),
        nativeInsertSuccesses,
        fallbackInsertSuccesses,
        clearSuccesses,
        failures,
        lastMethod
      };
    }
  };
})();
