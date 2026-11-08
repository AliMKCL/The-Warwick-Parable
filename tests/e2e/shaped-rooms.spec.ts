import { traversePassage } from './corridor-helpers';
import { expect, test, type Page } from '@playwright/test';

// The L and U rooms and the lift lobby, forced with ?layout= so they come up at once.
const W = (page: Page) => page.evaluate(() => (window as any).__WHACK__.state());

async function waitForRoom(page: Page, index: number) {
  await page.waitForFunction((i) => (window as any).__WHACK__.state().room?.index === i, index, { timeout: 60_000 });
  await page.waitForTimeout(1500);
}

/** Walk on (taking the first open door) until a room of this type appears; a gamble room may come first. */
async function reach(page: Page, archetype: string) {
  for (let i = 0; i < 4; i++) {
    await waitForRoom(page, await leave(page));
    if ((await W(page)).room.archetype === archetype) return;
  }
  throw new Error(`never reached a ${archetype}`);
}

async function leave(page: Page) {
  // A room rule may have locked the exits; this test is about the rooms, so open them.
  await page.evaluate(() => (window as any).__WHACK__.effect({ kind: 'doors', locked: [] }));
  const st = await W(page);
  const exit = st.room.doors.find((d: any) => !d.entrance);
  await page.evaluate((id) => (window as any).__WHACK__.useDoor(id), exit.id);
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as any).__WHACK__.interact());
  await traversePassage(page);
  return st.room.index + 1;
}

test('lift lobby, L and U rooms', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto('/?seed=4242&debug=1&dpr=1&post=0&observe=0&mute=1&layout=lift_lobby,l_gallery,u_gallery&tests=4&fillers=2');
  await page.evaluate(() => (window as any).__WHACK__.begin());
  await waitForRoom(page, 0);

  // The lift lobby, then an L and a U (each in the first room it fits).
  await reach(page, 'lift_lobby');
  const lift = await W(page);
  expect(lift.room.archetype).toBe('lift_lobby');
  expect(lift.rule?.id).toBe('lift_wait');
  const exit = lift.room.doors.find((d: any) => !d.entrance);
  expect(exit.label).toBe('MAINTENANCE');
  await page.screenshot({ path: 'artifacts/lift-spawn.png' });

  // Look at the call button and press it.
  const call = lift.room.props.find((p: any) => p.id === 't_call');
  const doors = lift.room.props.find((p: any) => p.id === 't_lift');
  const back = [Math.sign(lift.player.x - doors.x) * (Math.abs(lift.player.x - doors.x) > 1 ? 1 : 0), Math.sign(lift.player.z - doors.z) * (Math.abs(lift.player.z - doors.z) > 1 ? 1 : 0)];
  await page.evaluate(({ c, b }) => (window as any).__WHACK__.lookFrom(c.x + b[0] * 1.2, c.z + b[1] * 1.2, c.x, 1.15, c.z), { c: call, b: back });
  await page.waitForTimeout(500);
  const hovered = (await W(page)).hovered;
  expect(hovered?.kind).toBe('button');
  expect(hovered?.verb).toBe('Call the lift');
  await page.evaluate(() => (window as any).__WHACK__.interact());
  // Stand back and watch the floor indicator for a while.
  await page.evaluate(({ d, b }) => (window as any).__WHACK__.lookFrom(d.x + b[0] * 3.4, d.z + b[1] * 3.4, d.x, 1.7, d.z), { d: doors, b: back });
  await page.waitForTimeout(16_000);
  await page.screenshot({ path: 'artifacts/lift-waiting.png' });
  // The maintenance door.
  await page.evaluate((d) => {
    const dir = ({ n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] } as any)[d.side];
    (window as any).__WHACK__.lookFrom(d.cx + 0.5 - dir[0] * 2.6, d.cz + 0.5 - dir[1] * 2.6, d.cx + 0.5 + dir[0], 1.5, d.cz + 0.5 + dir[1]);
  }, exit);
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'artifacts/lift-maintenance-door.png' });

  // Then an L and a U.
  await reach(page, 'l_gallery');
  await page.screenshot({ path: 'artifacts/l-gallery.png' });
  await reach(page, 'u_gallery');
  await page.screenshot({ path: 'artifacts/u-gallery.png' });

  expect(errors).toEqual([]);
});

test('the run ends in a hallway whose far door glows warmer than the rest', async ({ page }) => {
  test.setTimeout(200_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto('/?seed=31&debug=1&dpr=1&observe=0&mute=1&tests=1&fillers=0');
  await page.waitForFunction(() => !!(window as any).__WHACK__);
  await page.evaluate(() => (window as any).__WHACK__.begin());
  await waitForRoom(page, 0);
  await waitForRoom(page, await leave(page));
  expect((await W(page)).room.archetype).not.toBe('finale_hall');
  await waitForRoom(page, await leave(page));
  const st = await W(page);
  expect(st.room.archetype).toBe('finale_hall');
  const door = st.room.doors.find((d: any) => d.finale);
  expect(door).toBeTruthy();
  // Look down the hallway at it.
  await page.evaluate((d) => {
    const dir = ({ n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] } as any)[d.side];
    (window as any).__WHACK__.lookFrom(d.cx + 0.5 - dir[0] * 6, d.cz + 0.5 - dir[1] * 6, d.cx + 0.5 + dir[0], 1.2, d.cz + 0.5 + dir[1]);
  }, door);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'artifacts/finale-hallway.png' });
  expect(errors).toEqual([]);
});
