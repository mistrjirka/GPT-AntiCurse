from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, got {count}")
    p.write_text(text.replace(old, new, 1))


# Keep shared content-script sources byte-identical while CI validates them.
for name in ("windowed.js", "debug-state.js"):
    firefox = Path("firefox") / name
    chrome = Path("chrome") / name
    chrome.write_text(firefox.read_text())

# ChatGPT can show a global/shell loading state with data-stream-active, an inert
# composer, a Stop button, and no usable response turn. That state is normal
# loading and must never arm the inactivity countdown.
path = "firefox/stall-recovery.js"
replace_once(
    path,
    '''  function hasUserDraft() { return !!draftText() || hasAttachmentDraft(); }
  function composerContainsOnlyNudge() { return draftText() === "." && !hasAttachmentDraft(); }''',
    '''  function hasUserDraft() { return !!draftText() || hasAttachmentDraft(); }
  function composerContainsOnlyNudge() { return draftText() === "." && !hasAttachmentDraft(); }

  function shellLoading() {
    const input = composer();
    const form = (input && input.closest('form[data-type="unified-composer"]')) || document.querySelector('form[data-type="unified-composer"]');
    if (form && (form.hasAttribute("inert") || form.inert === true)) return true;
    return !!(activeTurn && !activeTurn.isConnected);
  }'''
)

p = Path(path)
text = p.read_text()
text = text.replace("if (preOutputLoading(activeTurn)) return null;", "if (shellLoading() || preOutputLoading(activeTurn)) return null;")
text = text.replace("const loading = preOutputLoading(activeTurn);", "const loading = shellLoading() || preOutputLoading(activeTurn);")
text = text.replace("if (preOutputLoading(activeTurn)) { publishRecoveryStatus(); return; }", "if (shellLoading() || preOutputLoading(activeTurn)) { publishRecoveryStatus(); return; }")
text = text.replace(
    '''      if (turnList && turnList.isConnected) return;
      turnList = null;''',
    '''      if (turnList && turnList.isConnected) return;
      if (activeTurn && !activeTurn.isConnected) observeActiveTurn(null);
      turnList = null;'''
)
text = text.replace(
    '''        assistantOutputPresent: hasAssistantOutput(),
        preOutputLoading: preOutputLoading(),''',
    '''        assistantOutputPresent: hasAssistantOutput(),
        preOutputLoading: preOutputLoading(),
        shellLoading: shellLoading(),'''
)
p.write_text(text)
Path("chrome/stall-recovery.js").write_text(text)

# Add a static regression assertion for the exact shell-loading condition.
test = Path("tests/test-stall-recovery.js")
t = test.read_text()
needle = 'assert(chromeSource.includes("function preOutputLoading"), "pre-output streaming/loading must be a distinct non-armed state");\n'
addition = needle + 'assert(chromeSource.includes("function shellLoading"), "inert ChatGPT shell loading must be a distinct non-armed state");\nassert(chromeSource.includes("shellLoading() || preOutputLoading(activeTurn)"), "ordinary recovery must stay unarmed while ChatGPT itself is still loading");\n'
if 'function shellLoading' not in t:
    if needle not in t:
        raise SystemExit("tests/test-stall-recovery.js: shell-loading assertion anchor missing")
    t = t.replace(needle, addition, 1)
test.write_text(t)
