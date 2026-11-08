import { expect, test, type Page } from '@playwright/test';

/** Walks through the five office tasks in the browser, using each one's real interaction. */

const W = (page: Page) => page.evaluate(() => (window as any).__WHACK__.state());
const log = (page: Page) => page.evaluate(() => (window as any).__WHACK__.taskLog());

async function waitForRoom(page: Page, index: number) {
  await page.waitForFunction((i) => (window as any).__WHACK__.state().room?.index === i, index, { timeout: 60_000 });
  await page.waitForTimeout(1500); // fade-in
}

/** Stand `dist` metres in front of a prop and look at it (at height `y`). */
async function face(page: Page, propId: string, dist: number, y?: number) {
  await page.evaluate(({ propId, dist, y }) => {
    const w = (window as any).__WHACK__;
    const p = w.state().room.props.find((x: any) => x.id === propId);
    w.lookFrom(p.x + Math.sin(p.rotY) * dist, p.z + Math.cos(p.rotY) * dist, p.x, y ?? p.y + 0.1, p.z);
  }, { propId, dist, y });
  await page.waitForTimeout(700);
}

async function leaveBy(page: Page, doorId: string, next: number) {
  await page.evaluate((id) => (window as any).__WHACK__.useDoor(id), doorId);
  await page.waitForTimeout(700);
  expect((await W(page)).hovered?.kind, `door ${doorId}`).toBe('door');
  await page.evaluate(() => (window as any).__WHACK__.interact());
  await waitForRoom(page, next);
}

test('the five office tasks', async ({ page }) => {
  test.setTimeout(400_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.location().url.includes('/llm') && errors.push(m.text()));
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto('/?seed=4242&debug=1&dpr=1&post=0&mute=1');
  await page.evaluate(() => (window as any).__WHACK__.begin());
  await waitForRoom(page, 0);

  // Room 0, the baseline: press the button, leave.
  const s0 = await W(page);
  const button = s0.room.props.find((p: any) => p.recipe === 'button_pedestal');
  await face(page, button.id, 1, 1.03);
  await page.evaluate(() => (window as any).__WHACK__.interact());
  await leaveBy(page, s0.room.doors.find((d: any) => !d.entrance).id, 1);

  // 1. The Two Doors.
  let s = await W(page);
  expect(s.task.id).toBe('two_doors');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'artifacts/tasks-1-two-doors.png' });
  expect((await log(page)).some((e: any) => e.task === 'two_doors' && e.type === 'narrator_start')).toBe(true);
  await leaveBy(page, s.task.params.forbiddenDoor, 2);

  // 2. The Lift That Never Comes.
  s = await W(page);
  expect(s.task.id).toBe('lift');
  await face(page, 't_call', 0.9);
  expect((await W(page)).hovered).toMatchObject({ kind: 'button', verb: 'Call the lift' });
  for (let i = 0; i < 3; i++) { await page.evaluate(() => (window as any).__WHACK__.interact()); await page.waitForTimeout(250); }
  await face(page, 't_lift', 3.2, 1.6);
  await page.waitForTimeout(4500); // the indicator moves
  await page.screenshot({ path: 'artifacts/tasks-2-lift.png' });
  expect((await log(page)).filter((e: any) => e.task === 'lift' && e.data.action === 'press')).toHaveLength(3);
  await leaveBy(page, s.task.params.stairsDoor, 3);

  // 3. The Abandoned Desk: items can only be used up close.
  s = await W(page);
  expect(s.task.id).toBe('desk');
  await face(page, 't_email', 2.4);
  await page.screenshot({ path: 'artifacts/tasks-3-desk.png' });
  expect((await W(page)).hovered, 'out of reach').toBeUndefined();
  await face(page, 't_sticky', 0.9);
  expect((await W(page)).hovered?.id).toBe('t_sticky');
  await page.evaluate(() => (window as any).__WHACK__.interact());
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'artifacts/tasks-3-desk-note.png' });
  await page.evaluate(() => (window as any).__WHACK__.interact()); // close the card
  const closed = (await log(page)).find((e: any) => e.task === 'desk' && e.data.action === 'inspect_close');
  expect(closed?.data.seconds).toBeGreaterThan(0.5);
  await leaveBy(page, s.task.params.exitDoor, 4);

  // 4. Late for the Meeting: the countdown, the colleague's request, hold E to help.
  s = await W(page);
  expect(s.task.id).toBe('meeting');
  await face(page, 't_printer', 1.0, 0.9);
  await page.waitForTimeout(1500);
  expect((await log(page)).some((e: any) => e.task === 'meeting' && e.type === 'prompt_shown' && e.data.prompt === 'help')).toBe(true);
  expect((await W(page)).hovered?.kind).toBe('hold');
  await page.evaluate(() => (window as any).__WHACK__.interact());
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'artifacts/tasks-4-meeting.png' });
  await page.waitForFunction(() => !(window as any).__WHACK__.state().holding, null, { timeout: 15_000 });
  expect((await log(page)).some((e: any) => e.task === 'meeting' && e.data.action === 'hold_end' && e.data.completed)).toBe(true);
  await leaveBy(page, s.task.params.secretDoor, 5);

  // 5. The Smoky Corridor.
  s = await W(page);
  expect(s.task.id).toBe('smoke');
  await page.waitForFunction(() => (window as any).__WHACK__.state().smoke > 0.05, null, { timeout: 30_000 });
  const worker = s.room.props.find((p: any) => p.recipe === 'worker_seated');
  if (worker) {
    await face(page, worker.id, -1.3, 1.2); // from behind the chair
    if ((await W(page)).hovered?.kind === 'button') await page.evaluate(() => (window as any).__WHACK__.interact());
  }
  await face(page, 't_alarm', 3.5, 1.5);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'artifacts/tasks-5-smoke.png' });
  await face(page, 't_alarm', 0.8);
  expect((await W(page)).hovered?.verb).toBe('Pull the fire alarm');
  await page.evaluate(() => (window as any).__WHACK__.interact());
  await page.waitForFunction(() => (window as any).__WHACK__.state().smoke > 0.3, null, { timeout: 60_000 });
  await face(page, 't_vent', 5, 1.9);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'artifacts/tasks-5-smoke-later.png' });
  await leaveBy(page, s.task.params.fireExitDoor, 6);

  // The final room, then the file.
  const last = await W(page);
  expect(last.taskResults.map((r: any) => r.task)).toEqual(['two_doors', 'lift', 'desk', 'meeting', 'smoke']);
  await page.evaluate(() => (window as any).__WHACK__.effect({ kind: 'doors', locked: [] }));
  await page.evaluate((id) => (window as any).__WHACK__.useDoor(id), last.room.doors.find((d: any) => !d.entrance).id);
  await page.waitForTimeout(700);
  await page.evaluate(() => (window as any).__WHACK__.interact());
  await page.waitForFunction(() => (window as any).__WHACK__.state().ended, null, { timeout: 60_000 });
  await page.waitForTimeout(1200);
  const d = (await W(page)).dossier;
  const byTask = Object.fromEntries(d.tasks.map((t: any) => [t.task, t.metrics]));
  expect(byTask.two_doors.compliance).toBe(0);
  expect(byTask.lift.button_presses).toBe(3);
  expect(byTask.desk.follow_through).toBe(1);
  expect(byTask.meeting.helped).toBe(1);
  expect(byTask.smoke.raised_alarm).toBe(1);
  await page.locator('#dossier .tasks').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/tasks-6-dossier.png' });
  expect(errors).toEqual([]);
});
