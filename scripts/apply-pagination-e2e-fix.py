from pathlib import Path

path = Path("tests/e2e-chromium.js")
text = path.read_text()
old = 'assert.equal(state.cursor, "older-page", "newest page must preserve ChatGPT\'s real pagination cursor");'
new = 'assert.equal(state.cursor, "older-page-2", "newest page must preserve ChatGPT\'s real pagination cursor");'
count = text.count(old)
if count == 1:
    path.write_text(text.replace(old, new, 1))
elif new not in text:
    raise SystemExit(f"tests/e2e-chromium.js: expected cursor assertion not found (old matches={count})")
