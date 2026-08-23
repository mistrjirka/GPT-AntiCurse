/* Controlled-editor input bridge for ChatGPT's contenteditable composer. */
(() => {
  "use strict";

  let insertAttempts = 0;
  let nativeInsertSuccesses = 0;
  let clearAttempts = 0;
  let nativeClearSuccesses = 0;
  let lastOperation = null;

  function selectContents(node, collapseToEnd = false) {
    const selection = globalThis.getSelection && globalThis.getSelection();
    if (!selection || !node) return false;
    const range = document.createRange();
    range.selectNodeContents(node);
    if (collapseToEnd) range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function insertText(node, text) {
    insertAttempts++;
    lastOperation = "insert";
    if (!node || !node.isConnected || String(node.textContent || "").trim()) return false;
    try { node.focus({ preventScroll: true }); } catch { node.focus(); }
    selectContents(node, false);
    try {
      if (typeof document.execCommand === "function" && document.execCommand("insertText", false, String(text))) {
        const accepted = String(node.textContent || "").trim() === String(text).trim();
        if (accepted) nativeInsertSuccesses++;
        return accepted;
      }
    } catch { /* caller owns compatibility fallback */ }
    return false;
  }

  function clearExactText(node, expectedText) {
    clearAttempts++;
    lastOperation = "clear";
    if (!node || !node.isConnected || String(node.textContent || "").trim() !== String(expectedText || "").trim()) return false;
    try { node.focus({ preventScroll: true }); } catch { node.focus(); }
    if (!selectContents(node, false)) return false;
    try {
      if (typeof document.execCommand === "function" && document.execCommand("delete", false, null)) {
        const cleared = !String(node.textContent || "").trim();
        if (cleared) nativeClearSuccesses++;
        return cleared;
      }
    } catch { /* caller owns compatibility fallback */ }
    return false;
  }

  globalThis.CGAntiCurseComposerInput = Object.freeze({
    insertText,
    clearExactText,
    debug() { return { insertAttempts, nativeInsertSuccesses, clearAttempts, nativeClearSuccesses, lastOperation }; }
  });
})();
