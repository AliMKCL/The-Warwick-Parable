import { traversePassage } from './corridor-helpers';
import { expect, test, type Page } from '@playwright/test';

const W = (page: Page) => page.evaluate(() => (window as any).__WHACK__.state());

async function waitForRoom(page: Page, index: number) {
  await page.waitForFunction((i) => (window as any).__WHACK__.state().room?.index === i, index, { timeout: 60_000 });
  await page.waitForTimeout(1200);
}

test('room rules change the world', async ({ page }) => {
  test.setTimeout(500_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 960, height: 540 });
  // Only the four rules this test checks, so the seed always leads through the same rooms.
  await page.goto('/?seed=99&debug=1&dpr=1&observe=0&post=0&pool=exit_timer,inspect_to_unlock,lights_dim_on_idle,narrator_suggests');
  await page.evaluate(() => (window as any).__WHACK__.begin());
  await waitForRoom(page, 0);

  const seen = new Set<string>();
  for (let i = 0; i < 5 && seen.size < 3; i++) {
    const st = await W(page);
    const exit = st.room.doors.find((d: any) => !d.entrance);
    await page.evaluate((id) => (window as any).__WHACK__.useDoor(id), exit.id);
    await page.waitForTimeout(400);
    await page.evaluate(() => (window as any).__WHACK__.interact());
    await traversePassage(page);
    await waitForRoom(page, i + 1);
    const now = await W(page);
    const rule = now.rule?.id;
    if (!rule) continue;
    // Rules start after the entry line has been read.
    await page.waitForTimeout(9000);
    const after = await W(page);
    if (rule === 'inspect_to_unlock') {
      expect(after.locked.length, 'exits locked').toBeGreaterThan(0);
      const door = after.room.doors.find((d: any) => !d.entrance);
      await page.evaluate((id) => (window as any).__WHACK__.useDoor(id), door.id);
      await page.waitForTimeout(400);
      await page.screenshot({ path: 'artifacts/p4-rule-locked.png' });
      await page.evaluate(() => (window as any).__WHACK__.interact());
      await page.waitForTimeout(300);
      expect((await W(page)).events).toContain('door_tried');
    } else if (rule === 'exit_timer') {
      await expect(page.locator('#timer')).toHaveClass(/show/);
      await page.screenshot({ path: 'artifacts/p4-rule-timer.png' });
    } else if (rule === 'lights_dim_on_idle') {
      await page.waitForFunction(() => (window as any).__WHACK__.state().lights < 0.5, null, { timeout: 30_000 });
      await page.screenshot({ path: 'artifacts/p4-rule-dark.png' });
    }
    seen.add(rule);
    // Wait out any lock or timer, then move on.
    if (rule === 'inspect_to_unlock') {
      // Inspect enough things to unlock: stand near each inspectable prop.
      for (const p of after.room.props) {
        if ((await W(page)).locked.length === 0) break;
        await page.evaluate(({ x, z }) => {
          const w = (window as any).__WHACK__;
          const st = w.state();
          const W = st.room.doors.length; void W;
          for (const [dx, dz] of [[1.1, 0], [-1.1, 0], [0, 1.1], [0, -1.1]]) {
            w.lookFrom(x + dx, z + dz, x, 0.9, z);
            if (w.state().hovered?.kind === 'inspect') return;
          }
        }, p);
        await page.waitForTimeout(250);
        if ((await W(page)).hovered?.kind === 'inspect') {
          await page.evaluate(() => (window as any).__WHACK__.interact());
          await page.waitForTimeout(150);
          await page.evaluate(() => (window as any).__WHACK__.interact());
        }
      }
      await page.waitForFunction(() => (window as any).__WHACK__.state().locked.length === 0, null, { timeout: 20_000 });
    }
    if (rule === 'exit_timer') {
      const secs = Number(now.rule.params.seconds);
      await page.waitForFunction(() => (window as any).__WHACK__.state().locked.length > 0 || (window as any).__WHACK__.state().room.doors.filter((d: any) => !d.entrance).length === 1, null, { timeout: (secs + 15) * 1000 });
      const s2 = await W(page);
      // Leave through the door that stayed open.
      const open = s2.room.doors.find((d: any) => !d.entrance && !s2.locked.includes(d.id));
      await page.evaluate((id) => (window as any).__WHACK__.useDoor(id), open.id);
      await page.waitForTimeout(400);
      await page.evaluate(() => (window as any).__WHACK__.interact());
      await traversePassage(page);
      await waitForRoom(page, i + 2);
      i++;
    }
  }
  console.log('rules seen:', [...seen].join(', '));
  expect(seen.size).toBeGreaterThan(0);
  const final = await W(page);
  expect(final.evidence).toBeGreaterThan(0);
  await page.screenshot({ path: 'artifacts/p4-debug.png' });
  expect(errors).toEqual([]);
});
