import { expect, test } from '@playwright/test';
import { leavePassage, state, stepThrough, walkPassage } from './corridor-helpers';

test('physical corridor, contextual interactables, sealed doors and seamless arrival', async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Keep this check offline and deterministic regardless of local model/voice credentials.
  await page.route((url) => url.pathname.startsWith('/llm/'), (route) => route.fulfill({ status: 503, body: 'offline test' }));
  await page.route((url) => url.pathname.startsWith('/tts/'), (route) => route.fulfill({ status: 503, body: 'offline test' }));
  await page.goto('/?seed=20261107&post=0&dpr=1&mute=1&tests=1&fillers=0&pool=choice');
  await page.evaluate(() => (window as any).__WHACK__.begin());
  await page.waitForTimeout(1400);
  await page.evaluate(() => {
    const w = window as any;
    w.transitionScreens = [];
    new MutationObserver(() => {
      if (!document.getElementById('fade')!.classList.contains('clear') || document.getElementById('waiting')!.classList.contains('show')) w.transitionScreens.push('blocked');
    }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
    w.__WHACK__.useDoor('d1');
  });
  await page.waitForTimeout(250);
  await page.evaluate(() => (window as any).__WHACK__.interact());
  await page.waitForTimeout(600);
  expect((await state(page)).events.filter((e: string) => e === 'door_chosen')).toHaveLength(0);
  await page.screenshot({ path: 'artifacts/corridor-open-door.png' });
  await stepThrough(page);
  await page.waitForFunction(() => (window as any).__WHACK__.state().corridor?.entered);
  expect((await state(page)).corridor.sealed).toBe(true);
  expect((await state(page)).room.index).toBe(0); // preparation is not a visit
  await page.waitForFunction(() => (window as any).__WHACK__.state().corridor?.fromDisposed);

  // Try walking back through the sealed entrance. Collision holds at the threshold.
  const before = await state(page);
  const entrance = before.corridor.layout.doors.find((d: any) => d.entrance);
  const directions: Record<string, number[]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
  const [dx, dz] = directions[entrance.side]!;
  const cx = before.corridor.x + entrance.cx + 0.5 + dx! * 0.5;
  const cz = before.corridor.z + entrance.cz + 0.5 + dz! * 0.5;
  await page.evaluate(({ cx, cz, dx, dz }) => (window as any).__WHACK__.lookFrom(cx - dx * 0.85, cz - dz * 0.85, cx, 1.2, cz), { cx, cz, dx: dx!, dz: dz! });
  await page.waitForTimeout(100);
  expect((await state(page)).hovered?.kind).toBe('locked');
  await page.evaluate(() => (window as any).__WHACK__.interact());
  await stepThrough(page);
  const blocked = (await state(page)).player;
  expect((blocked.x - cx) * dx! + (blocked.z - cz) * dz!).toBeLessThan(-0.27);

  // Read a record, then close it and walk the complete route through both bends.
  const c = (await state(page)).corridor;
  const receipt = c.props.find((p: any) => p.id === 'receipt');
  await page.evaluate(({ c, p }) => {
    const x = c.x + p.x, z = c.z + p.z;
    (window as any).__WHACK__.lookFrom(x + Math.sin(p.rotY) * 1.2, z + Math.cos(p.rotY) * 1.2, x, 1.5, z);
  }, { c, p: receipt });
  await page.waitForFunction(() => (window as any).__WHACK__.state().hovered?.id === 'receipt');
  await page.evaluate(() => (window as any).__WHACK__.interact());
  await expect(page.locator('#inspect-text')).toContainText('ROUTE RECEIPT');
  await expect(page.locator('#inspect-text')).toContainText('Objects inspected: 0');
  await page.evaluate(() => (window as any).__WHACK__.interact());
  await page.screenshot({ path: 'artifacts/corridor-records.png' });
  // Return to the inside of the entrance to verify the entire traversable route.
  await page.evaluate(({ cx, cz, dx, dz }) => (window as any).__WHACK__.lookFrom(cx - dx * 0.85, cz - dz * 0.85, cx - dx * 3, 1.62, cz - dz * 3), { cx, cz, dx: dx!, dz: dz! });
  await walkPassage(page);
  await leavePassage(page);
  const arrived = await state(page);
  expect(arrived.room.index).toBe(1);
  expect(arrived.events.filter((e: string) => e === 'door_chosen')).toHaveLength(1);
  expect(arrived.events.filter((e: string) => e === 'inspected')).toHaveLength(0);
  expect(arrived.events).toContain('corridor_interacted');
  expect(await page.evaluate(() => (window as any).transitionScreens)).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'artifacts/corridor-arrival.png' });
});
