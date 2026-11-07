import { expect, test } from '@playwright/test';

for (const mood of (process.env.MOODS ?? 'cold,warm,sickly,dim').split(',')) {
  test(`mood: ${mood}`, async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 960, height: 540 });
    await page.goto(`/?seed=20261107&dpr=1&ambience=${mood}&mute=1`);
    await page.evaluate(() => (window as any).__WHACK__.begin());
    await page.waitForFunction(() => (window as any).__WHACK__.state().room?.index === 0, null, { timeout: 60_000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `artifacts/p5-mood-${mood}.png` });
    if (mood === 'cold') expect(await page.evaluate(() => (window as any).__WHACK__.soundCheck())).not.toBe('none');
    expect(errors).toEqual([]);
  });
}
