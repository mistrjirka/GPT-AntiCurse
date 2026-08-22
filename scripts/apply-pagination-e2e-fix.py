from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, got {count}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "tests/e2e-chromium.js",
'''      const auth = request.headers()["authorization"] || "";
      assert(["Bearer e2e-access-token", "Bearer bootstrap-access-token"].includes(auth), `unexpected paginated export auth: ${auth}`);
      const url = new URL(request.url());''',
'''      const auth = request.headers()["authorization"] || "";
      // The real ChatGPT page now sees the truthful newest-page cursor and may
      // make one native before-page request with no Authorization header. The
      // isolated AntiCurse archive/export fetch remains authenticated.
      if (auth) {
        assert(["Bearer e2e-access-token", "Bearer bootstrap-access-token"].includes(auth), `unexpected paginated export auth: ${auth}`);
      }
      const url = new URL(request.url());'''
)

replace_once(
    "tests/e2e-firefox.js",
'''    if (url.pathname === "/backend-api/conversations/e2e-firefox/messages") {
      assert.equal(req.headers.authorization || "", "Bearer firefox-e2e-token");
      assert.equal(url.searchParams.get("include_has_versions"), "true");''',
'''    if (url.pathname === "/backend-api/conversations/e2e-firefox/messages") {
      // Native ChatGPT pagination is intentionally allowed one request and has
      // no Authorization header. AntiCurse's isolated authoritative fetch does.
      if (req.headers.authorization) assert.equal(req.headers.authorization, "Bearer firefox-e2e-token");
      assert.equal(url.searchParams.get("include_has_versions"), "true");'''
)
