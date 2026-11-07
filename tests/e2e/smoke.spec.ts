import { expect, test } from '@playwright/test';

test('setup scene renders without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.location().url.includes('/llm') && errors.push(m.text()));

  await page.goto('/');
  await expect(page.locator('#status-renderer')).toHaveText(/WebGL/);
  await page.waitForFunction(() => (window as any).__WHACK__?.renderer?.render?.frame > 10);

  // The canvas should contain a real picture, not a blank or single-colour frame.
  const stats = await page.evaluate(() => (window as any).__WHACK__.sampleFrame());
  expect(stats.sd).toBeGreaterThan(4);
  await page.screenshot({ path: 'artifacts/phase1-setup.png' });
  expect(errors).toEqual([]);
});
