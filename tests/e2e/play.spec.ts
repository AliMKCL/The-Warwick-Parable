import { traversePassage } from './corridor-helpers';
import { expect, test, type Page } from '@playwright/test';

const W = (page: Page) => page.evaluate(() => (window as any).__WHACK__.state());

async function waitForRoom(page: Page, index: number) {
  await page.waitForFunction((i) => (window as any).__WHACK__.state().room?.index === i, index, { timeout: 60_000 });
  await page.waitForTimeout(1200); // fade-in
}

test('walk through generated rooms', async ({ page }) => {
  test.setTimeout(400_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.location().url.includes('/llm') && errors.push(m.text()));

  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto(`/?seed=20261107&debug=1&dpr=1&post=0${process.env.EXPECT_MODEL ? '&observe=1' : ''}`);
  await page.screenshot({ path: 'artifacts/p3-start-screen.png' });
  await page.evaluate(() => (window as any).__WHACK__.begin());
  await waitForRoom(page, 0);
  await page.screenshot({ path: 'artifacts/p3-room0-spawn.png' });

  // Press the button in the first room, then inspect something.
  const s0 = await W(page);
  expect(s0.room.archetype).toBe('waiting_room');
  const pedestal = s0.room.props.find((p: any) => p.recipe === 'button_pedestal');
  await page.evaluate(({ x, z }) => (window as any).__WHACK__.lookFrom(x, z + 1.0, x, 1.03, z), pedestal);
  await page.waitForTimeout(500);
  expect((await W(page)).hovered?.kind).toBe('button');
  await page.evaluate(() => (window as any).__WHACK__.interact());
  await page.waitForTimeout(300);
  expect((await W(page)).events).toContain('pressed');

  const other = s0.room.props.find((p: any) => ['water_cooler', 'plant_dead', 'trash_bin', 'vending_machine', 'table_round'].includes(p.recipe));
  if (other) {
    await page.evaluate(({ x, z }) => {
      const w = (window as any).__WHACK__;
      const st = w.state();
      // Stand 1.2 m from the prop on whichever side is inside the room.
      const cx = st.room.doors.length ? x : x;
      w.lookFrom(cx + (x < 4 ? 1.2 : -1.2), z, x, 0.8, z);
    }, other);
    await page.waitForTimeout(500);
    if ((await W(page)).hovered?.kind === 'inspect') {
      await page.evaluate(() => (window as any).__WHACK__.interact());
      await page.waitForTimeout(300);
      await page.screenshot({ path: 'artifacts/p3-room0-inspect.png' });
      expect((await W(page)).events).toContain('inspected');
      await page.evaluate(() => (window as any).__WHACK__.interact()); // close the card
    }
  }

  // Walk to every exit in turn across several rooms.
  for (let i = 0; i < (process.env.EXPECT_MODEL ? 3 : 5); i++) {
    // Spend a moment in the room, as a player would, so generation can finish.
    if (process.env.EXPECT_MODEL) await page.waitForFunction(() => (window as any).__WHACK__.state().gen?.some((g: any) => g.status === 'ready' || g.status === 'fallback'), null, { timeout: 60_000 });
    const st = await W(page);
    const exit = st.room.doors.find((d: any) => !d.entrance);
    // Room rules may lock doors; that is covered by rules.spec.ts, so open them here.
    await page.evaluate(() => (window as any).__WHACK__.effect({ kind: 'doors', locked: [] }));
    await page.evaluate((id) => (window as any).__WHACK__.useDoor(id), exit.id);
    await page.waitForTimeout(400);
    const hovered = (await W(page)).hovered;
    expect(hovered?.kind, `room ${i} door hover`).toBe('door');
    if (i === 0) await page.screenshot({ path: 'artifacts/p3-room0-door.png' });
    // A rule that starts while we walk up (e.g. inspect_to_unlock) may have locked it again.
    await page.evaluate(() => (window as any).__WHACK__.effect({ kind: 'doors', locked: [] }));
    await page.evaluate(() => (window as any).__WHACK__.interact());
    await traversePassage(page);
    await waitForRoom(page, i + 1);
    const now = await W(page);
    if (process.env.EXPECT_MODEL) expect(now.source, `room ${i + 1} source`).toBe(now.room.archetype === 'choice_room' ? 'template' : 'model');
    await page.screenshot({ path: `artifacts/p3-room${i + 1}-${now.room.archetype}.png` });
  }

  const final = await W(page);
  expect(final.events).toContain('room_entered');
  expect(final.events).toContain('door_chosen');
  expect(errors).toEqual([]);
});
