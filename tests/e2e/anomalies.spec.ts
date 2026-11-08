import { expect, test } from '@playwright/test';
import { Run } from '../../core/run/run';
import { loadGameData } from '../../tools/data-node';
import { ANOMALIES } from '../../core/anomalies/catalog';

// Find normal seeds, then reach each encounter through the real game entry and door controls.
test('all sixteen encounters render and accept a raycast interaction', async ({
  page,
}) => {
  test.setTimeout(900_000); // sixteen rooms; slow without a GPU
  const data = loadGameData();
  const seeds = new Map<string, number>();
  for (let seed = 1; seed < 4000 && seeds.size < ANOMALIES.length; seed++) {
    // One test and two fillers, so room 1 is sometimes a filler: false_exit only appears in a room with no test.
    const run = new Run(seed, data, { observeMs: 0, layout: { tests: 1, fillers: 2 } });
    const first = run.start();
    run.record({ type: 'room_entered', roomId: first.id, t: 0 });
    run.record({ type: 'door_chosen', roomId: first.id, doorId: 'd1', t: 3 });
    const room = await run.next('d1');
    if (room.anomaly) seeds.set(room.anomaly.id, seed);
    // Finish to clear generation work and keep the test runner free of active plans.
    await run.next('d1');
  }
  expect(seeds.size).toBe(16);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Only the model proxy (/llm/...), not source files such as /core/llm/client.ts.
  await page.route((url) => url.pathname.startsWith('/llm/'), (route) =>
    route.fulfill({ status: 503, body: '{}' }),
  );
  for (const [id, seed] of seeds) {
    await page.goto(`/?seed=${seed}&tests=1&fillers=2&observe=0&post=0&mute=1&dpr=1`);
    await page.waitForFunction(() => !!(window as any).__WHACK__);
    await page.evaluate(() => (window as any).__WHACK__.begin());
    await page.waitForFunction(
      () => (window as any).__WHACK__.state().room?.index === 0,
    );
    await page.waitForTimeout(1000);
    await page.evaluate(() => (window as any).__WHACK__.useDoor('d1'));
    await page.waitForTimeout(100);
    await page.evaluate(() => (window as any).__WHACK__.interact());
    await page.waitForFunction(
      () => (window as any).__WHACK__.state().room?.index === 1,
    );
    await page.waitForTimeout(1000);
    const anomaly = await page.evaluate(
      () => (window as any).__WHACK__.state().room.anomaly,
    );
    expect(anomaly?.id, `seed ${seed}`).toBe(id);
    let found = false;
    for (const height of [1.2, 1.75, 0.5]) {
      await page.evaluate(
        ({ anchor, height }) => {
          const sx = Math.sin(anchor.rotY),
            sz = Math.cos(anchor.rotY);
          (window as any).__WHACK__.lookFrom(
            anchor.x + sx * 1.45,
            anchor.z + sz * 1.45,
            anchor.x,
            height,
            anchor.z,
          );
        },
        { anchor: anomaly.anchor, height },
      );
      await page.waitForTimeout(100);
      if (
        (await page.evaluate(
          () => (window as any).__WHACK__.state().hovered?.kind,
        )) === 'anomaly'
      ) {
        found = true;
        break;
      }
    }
    expect(found, `${id} must be reachable through the normal raycast`).toBe(
      true,
    );
    await page.screenshot({ path: `artifacts/anomaly-${id}.png` });
    if (id === 'borrowed_clock') {
      await page.waitForTimeout(7000);
      if (await page.locator('#inspect').isVisible())
        await page.evaluate(() => (window as any).__WHACK__.interact());
    }
    await page.evaluate(() => (window as any).__WHACK__.interact());
    await expect(page.locator('#inspect')).toBeVisible();
    await page.evaluate(() => (window as any).__WHACK__.interact());
    if (
      [
        'weather_drawer',
        'ceiling_cabinet',
        'queue_plant',
        'hold_phone',
      ].includes(id)
    ) {
      await page.evaluate(() => (window as any).__WHACK__.interact());
      await expect(page.locator('#inspect')).toBeVisible();
      await page.evaluate(() => (window as any).__WHACK__.interact());
    }
    await page.screenshot({ path: `artifacts/anomaly-${id}-used.png` });
  }
  expect(errors).toEqual([]);
});
