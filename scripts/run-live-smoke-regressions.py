from pathlib import Path
import subprocess

p = Path("scripts/apply-live-smoke-regressions.py")
text = p.read_text()

# Adapt the Chromium E2E insertion to its block-scoped test structure.
start = text.index('# Chromium file uses Playwright helpers; patch its tool-timeout block by anchor.')
end = text.index('# Workflow includes new accumulator unit test.', start)
replacement = r'''# Chromium uses block-scoped Playwright cases rather than runCase().
replace_once(
    "tests/e2e-stall-recovery-chromium.js",
''' + "'''" + r'''    {
      await setPerformance(worker, true);
      const page = await openCase(context, "tool-timeout");''' + "'''" + r''',
''' + "'''" + r'''    {
      const page = await openCase(context, "pre-output-loading");
      await page.waitForFunction(() => (document.querySelector('#cg-conversation-guard-status')?.textContent || '').includes('response loading · recovery not armed'));
      await page.waitForTimeout(800);
      let current = await state(page);
      assert.equal(current.stopClicks, 0, "Chromium must not auto-stop while the response is still in pre-output loading/progress state");
      assert.equal(current.sends, 0);
      assert.equal(statusCounts.get("pre-output-loading") || 0, 0, "pre-output loading must not query stream_status on the ordinary timeout path");
      assert.equal(await page.evaluate(() => window.__revealAssistantOutput()), true);
      await page.waitForFunction(() => window.__state.sends === 1, null, { timeout: 3000 });
      await page.close();
    }

    {
      await setPerformance(worker, true);
      const page = await openCase(context, "tool-timeout");''' + "'''" + r'''
)

'''
text = text[:start] + replacement + text[end:]

# The workflow test list is managed directly through the GitHub connector.
marker = text.index('# Workflow includes new accumulator unit test.')
text = text[:marker] + '# Workflow test list is managed directly; source patch ends here.\n'
p.write_text(text)

subprocess.run(["python", str(p)], check=True)
