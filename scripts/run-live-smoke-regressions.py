from pathlib import Path

# The live-smoke source fixes are already committed. This temporary helper only
# keeps shared content-script sources byte-identical while CI validates them.
for name in ("windowed.js", "debug-state.js"):
    firefox = Path("firefox") / name
    chrome = Path("chrome") / name
    chrome.write_text(firefox.read_text())
