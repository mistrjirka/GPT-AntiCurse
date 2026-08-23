from pathlib import Path
import base64
import gzip
import hashlib

FILES = {
    "PRO": "pro.b64",
    "STALL": "stall.b64",
    "CONTENT": "content.b64",
    "TEST": "test.b64",
}
EXPECTED = {
    "PRO": "1656c300e8c02c529e816bf9e48dd2a49f9c4caf",
    "STALL": "54fcddf154f1fd16b9810fea6267b1cbf2a98399",
    "CONTENT": "5973aa0113bac72f24d0196b6f6ec1f9ddc2be13",
    "TEST": "5fe8e47144afe497f32d085015f7adf7c5eb1940",
}
ROOT = Path("scripts/hotfix5-payload")

def git_blob_sha(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()

def decode(name):
    encoded = (ROOT / FILES[name]).read_text().strip()
    data = gzip.decompress(base64.b64decode(encoded))
    actual = git_blob_sha(data)
    if actual != EXPECTED[name]:
        raise SystemExit(f"{name}: exact hotfix5 hash mismatch: {actual} != {EXPECTED[name]}")
    return data

decoded = {name: decode(name) for name in FILES}
for browser in ("firefox", "chrome"):
    Path(browser, "pro-recovery-guard.js").write_bytes(decoded["PRO"])
    Path(browser, "stall-recovery.js").write_bytes(decoded["STALL"])
    Path(browser, "content.js").write_bytes(decoded["CONTENT"])
Path("tests/test-stall-recovery.js").write_bytes(decoded["TEST"])

# Preserve already-tested shared live-history fixes byte-identically.
for name in ("windowed.js", "debug-state.js"):
    Path("chrome", name).write_bytes(Path("firefox", name).read_bytes())

print("Applied byte-exact live-tested hotfix5 recovery files.")
