import { traversePassage } from './corridor-helpers';
import { expect, test, type Page } from '@playwright/test';

const W = (page: Page) => page.evaluate(() => (window as any).__WHACK__.state());

test('a full run ends with the dossier', async ({ page }) => {
  test.setTimeout(400_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto('/?seed=7&dpr=1&post=0&observe=1&rooms=4&mute=1');
  await page.evaluate(() => (window as any).__WHACK__.begin());
  await page.waitForFunction(() => (window as any).__WHACK__.state().room?.index === 0, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);

  // Hesitate, then press the button in the first room.
  const s0 = await W(page);
  const pedestal = s0.room.props.find((p: any) => p.recipe === 'button_pedestal');
  await page.evaluate(({ x, z }) => (window as any).__WHACK__.lookFrom(x, z + 1.0, x, 1.03, z), pedestal);
  await page.waitForTimeout(7000);
  await page.evaluate(() => (window as any).__WHACK__.interact());

  for (let i = 0; i < 4; i++) {
    const st = await W(page);
    if (i < 3 && process.env.EXPECT_MODEL)
      await page.waitForFunction(() => (window as any).__WHACK__.state().gen?.some((g: any) => g.status === 'ready' || g.status === 'fallback'), null, { timeout: 60_000 });
    await page.evaluate(() => (window as any).__WHACK__.effect({ kind: 'doors', locked: [] }));
    const exit = st.room.doors.find((d: any) => !d.entrance);
    await page.evaluate((id) => (window as any).__WHACK__.useDoor(id), exit.id);
    await page.waitForTimeout(400);
    await page.evaluate(() => (window as any).__WHACK__.interact());
    await traversePassage(page);
    if (i < 3) {
      await page.waitForFunction((n) => (window as any).__WHACK__.state().room?.index === n, i + 1, { timeout: 60_000 });
      await page.waitForTimeout(1500);
    }
  }
  await page.waitForFunction(() => (window as any).__WHACK__.state().ended, null, { timeout: 60_000 });
  await page.waitForTimeout(1200);
  await expect(page.locator('#dossier')).toBeVisible();
  await expect(page.locator('#dossier h1')).not.toBeEmpty();
  await page.screenshot({ path: 'artifacts/p6-dossier.png', fullPage: false });
  await page.locator('#d-built').click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'artifacts/p6-built.png' });
  const d = (await W(page)).dossier;
  expect(d.rooms).toHaveLength(4);
  if (process.env.EXPECT_MODEL) expect(d.verdictSource).toBe('model');
  expect(errors).toEqual([]);
});
