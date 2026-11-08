import { expect, test, type Page } from '@playwright/test';

/** Opens each office task (tasks 6 to 11, from PR #6) as the run's only test, uses it once, and screenshots the room. */

const W = (page: Page) => page.evaluate(() => (window as any).__WHACK__.state());

async function enterTask(page: Page, id: string) {
  await page.goto(`/?tests=1&fillers=0&pool=${id}&seed=11&dpr=1&post=0&mute=1&debug=1&observe=0`);
  await page.waitForFunction(() => !!(window as any).__WHACK__);
  await page.evaluate(() => (window as any).__WHACK__.begin());
  await page.waitForFunction(() => (window as any).__WHACK__.state().room?.index === 0, null, { timeout: 60_000 });
  await page.waitForTimeout(1200);
  const s0 = await W(page);
  await page.evaluate((door) => (window as any).__WHACK__.useDoor(door), s0.room.doors.find((d: any) => !d.entrance).id);
  await page.waitForFunction(() => (window as any).__WHACK__.state().hovered?.kind === 'door', null, { timeout: 30_000 });
  await page.evaluate(() => (window as any).__WHACK__.interact());
  await page.waitForFunction(() => (window as any).__WHACK__.state().room?.index === 1, null, { timeout: 60_000 });
  expect((await W(page)).rule?.id).toBe(id);
  // The task starts once the narrator has introduced the room.
  await page.waitForFunction(() => (window as any).__WHACK__.state().ruleStarted, null, { timeout: 30_000 });
  await page.waitForTimeout(500);
}

/** Stand `dist` in front of a prop and look at it. */
async function face(page: Page, propId: string, dist: number, y?: number) {
  await page.evaluate(({ propId, dist, y }) => {
    const w = (window as any).__WHACK__;
    const p = w.state().room.props.find((x: any) => x.id === propId);
    w.lookFrom(p.x + Math.sin(p.rotY) * dist, p.z + Math.cos(p.rotY) * dist, p.x, y ?? p.y + 0.4, p.z);
  }, { propId, dist, y });
  await page.waitForTimeout(800);
}

async function use(page: Page, propId: string, dist = 0.9, y?: number) {
  await face(page, propId, dist, y);
  expect((await W(page)).hovered?.id, `aiming at ${propId}`).toBe(propId);
  await page.evaluate(() => (window as any).__WHACK__.interact());
  await page.waitForTimeout(500);
}

test('office tasks 6 to 11 open and respond', async ({ page }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 960, height: 540 });

  await enterTask(page, 'balloons');
  for (let i = 0; i < 4; i++) await use(page, 't_pump', 1.1, 0.9);
  await face(page, 't_balloon', 1.6, 1.0);
  await page.screenshot({ path: 'artifacts/office-6-balloons.png' });

  await enterTask(page, 'coffee');
  await use(page, 't_machine2', 1.2, 1.2);
  await face(page, 't_machine2', 2.6, 1.2);
  await page.screenshot({ path: 'artifacts/office-7-coffee.png' });

  await enterTask(page, 'canteen');
  await face(page, 't_now1', 2.2, 0.9);
  await page.screenshot({ path: 'artifacts/office-8-canteen.png' });

  await enterTask(page, 'renumbered');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'artifacts/office-9-renumbered.png' });

  await enterTask(page, 'pitch');
  await use(page, 't_lectern', 0.9, 1.0);
  expect((await page.evaluate(() => (window as any).__WHACK__.ask()))?.mode).toBe('slider');
  await page.keyboard.press('KeyD');
  await page.keyboard.press('KeyD');
  await page.screenshot({ path: 'artifacts/office-10a-pitch-confidence.png' });
  await page.evaluate(() => (window as any).__WHACK__.interact());
  await page.waitForTimeout(400);
  expect((await page.evaluate(() => (window as any).__WHACK__.ask()))?.mode).toBe('meter');
  await page.screenshot({ path: 'artifacts/office-10a-pitch-meter.png' });
  await page.evaluate(() => (window as any).__WHACK__.interact());
  await page.waitForTimeout(600);
  expect((await page.evaluate(() => (window as any).__WHACK__.ask()))?.mode).toBe('choice');
  await page.screenshot({ path: 'artifacts/office-10a-pitch-again.png' });
  await page.evaluate(() => (window as any).__WHACK__.answer(1));

  await enterTask(page, 'loan');
  await use(page, 't_borrower', 1.2, 1.5);
  await page.screenshot({ path: 'artifacts/office-10b-loan.png' });
  await page.evaluate(() => (window as any).__WHACK__.answer(6));

  await enterTask(page, 'lockdown');
  await use(page, 't_buzzer', 0.9, 1.3);
  await page.waitForTimeout(300);
  expect((await W(page)).locked.length).toBeGreaterThan(0);
  await page.screenshot({ path: 'artifacts/office-11-lockdown.png' });

  expect(errors).toEqual([]);
});
