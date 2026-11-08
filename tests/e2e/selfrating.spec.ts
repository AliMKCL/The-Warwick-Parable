import { expect, test, type Page } from '@playwright/test';

const W = (page: Page) => page.evaluate(() => (window as any).__WHACK__.state());

test('begin stays disabled until every slider is set (and consent ticked, when asked)', async ({ page }) => {
  await page.goto('/?seed=5&dpr=1&post=0&mute=1');
  const begin = page.locator('#start-button');
  await expect(begin).toBeDisabled();
  await expect(page.locator('#self-ratings')).not.toContainText('Optional');
  const sliders = page.locator('#self-ratings input[type=range]');
  await expect(sliders).toHaveCount(4);
  // One click per slider; clicking the middle (the default, 3) still counts as setting it.
  for (let i = 0; i < 4; i++) {
    await expect(begin).toBeDisabled();
    await sliders.nth(i).click();
  }
  const consent = page.locator('#consent');
  if (await page.locator('#consent-row').isVisible()) {
    await expect(begin).toBeDisabled();
    await consent.check();
  }
  await expect(begin).toBeEnabled();
  await expect(page.locator('#self-ratings output').first()).toHaveText('3');
});

test('the dossier opens with what you said next to what you did', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?seed=7&dpr=1&post=0&observe=1&rooms=5&mute=1');
  await page.evaluate(() => (window as any).__WHACK__.begin({ selfRatings: { risk: 5, patience: 3, social: 3, exploration: 1 } }));
  await page.waitForFunction(() => (window as any).__WHACK__.state().room?.index === 0, null, { timeout: 60_000 });
  await page.waitForTimeout(1200);

  let gambles = 0;
  for (let i = 0; i < 8 && !(await W(page)).ended; i++) {
    const st = await W(page);
    // Always the certain door: a player who said they take risks, and did not.
    const door = st.rule?.id === 'gamble' ? st.rule.params.safe : st.room.doors.find((d: any) => !d.entrance).id;
    if (st.rule?.id === 'gamble') {
      gambles++;
      expect(st.room.doors.find((d: any) => d.id === st.rule.params.safe).label).toMatch(/CERTAIN/);
      expect(st.room.doors.find((d: any) => d.id === st.rule.params.risky).label).toMatch(/50\/50/);
    }
    await page.evaluate(() => (window as any).__WHACK__.effect({ kind: 'doors', locked: [] }));
    await page.evaluate((id) => (window as any).__WHACK__.useDoor(id), door);
    await page.waitForTimeout(400);
    await page.evaluate(() => (window as any).__WHACK__.interact());
    await page.waitForFunction((n) => { const s = (window as any).__WHACK__.state(); return s.ended || s.room?.index === n; }, i + 1, { timeout: 60_000 });
    await page.waitForTimeout(1200);
  }
  expect(gambles).toBe(2);
  await page.waitForFunction(() => (window as any).__WHACK__.state().ended, null, { timeout: 60_000 });
  await expect(page.locator('#dossier .saiddid .headline')).toHaveText('You said you take risks. You chose the certain door every time.');
  await expect(page.locator('#dossier .sd-row')).toHaveCount(4);
  await expect(page.locator('#dossier .sd-row').first()).toContainText('You said: 5/5');
  await expect(page.locator('#dossier .sd-row').first()).toContainText('You did: 1/5');
  await page.screenshot({ path: 'artifacts/said-did-dossier.png' });
  expect(errors).toEqual([]);
});
