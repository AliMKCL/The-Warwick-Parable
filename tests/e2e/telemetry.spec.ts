import { expect, test, type Page } from '@playwright/test';

// Needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY set (any values); Supabase itself is faked here.
const W = (page: Page) => page.evaluate(() => (window as any).__WHACK__.state());

async function waitForRoom(page: Page, index: number) {
  await page.waitForFunction((i) => (window as any).__WHACK__.state().room?.index === i, index, { timeout: 60_000 });
  await page.waitForTimeout(1200);
}

test('records sessions and events without touching the game', async ({ page }) => {
  test.setTimeout(180_000);
  const sessions: any[] = [], updates: any[] = [], events: any[] = [];
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request();
    const body = req.postDataJSON();
    if (req.url().includes('/sessions') && req.method() === 'POST') {
      sessions.push(body);
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ world_id: 42 }) });
    }
    if (req.url().includes('/sessions') && req.method() === 'PATCH') updates.push(body);
    if (req.url().includes('/events')) events.push(...(Array.isArray(body) ? body : [body]));
    return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/?seed=4242&dpr=1&post=0&rooms=3&mute=1');
  await expect(page.locator('#research')).toBeVisible();
  await page.evaluate(() => (window as any).__WHACK__.begin({ telemetry: { risk: 4, patience: 2, social: null, exploration: 5 } }));
  await waitForRoom(page, 0);

  const s0 = await W(page);
  const pedestal = s0.room.props.find((p: any) => p.recipe === 'button_pedestal');
  await page.evaluate(({ x, z }) => (window as any).__WHACK__.lookFrom(x, z + 1.0, x, 1.03, z), pedestal);
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as any).__WHACK__.interact());

  for (let i = 0; i < 3; i++) {
    const st = await W(page);
    const exit = st.room.doors.find((d: any) => !d.entrance);
    await page.evaluate(() => (window as any).__WHACK__.effect({ kind: 'doors', locked: [] }));
    await page.evaluate((id) => (window as any).__WHACK__.useDoor(id), exit.id);
    await page.waitForTimeout(400);
    await page.evaluate(() => (window as any).__WHACK__.interact());
    if (i < 2) await waitForRoom(page, i + 1);
  }
  await page.waitForFunction(() => (window as any).__WHACK__.state().ended, null, { timeout: 60_000 });
  await expect.poll(() => updates.length, { timeout: 10_000 }).toBe(1);

  expect(sessions[0]).toMatchObject({ consent: true, self_ratings: { risk: 4, patience: 2, social: null, exploration: 5 } });
  expect(updates[0]).toMatchObject({ completed: true });
  expect(updates[0].profile.traits).toBeDefined();
  expect(updates[0].predictions.labels).toBeDefined();
  const types = events.map((e) => e.type);
  for (const t of ['run_start', 'room_enter', 'room_exit', 'interact', 'choice', 'task_start', 'task_done', 'run_end']) expect(types).toContain(t);
  expect(events.every((e) => e.session_id === sessions[0].id)).toBe(true);
  expect(events.find((e) => e.choice === 'press_button' && e.type === 'choice')).toMatchObject({ trait: 'social', trait_value: 'follow' });
  expect(events.filter((e) => e.type === 'choice' && e.meta.kind === 'door')).toHaveLength(3);
  expect(errors).toEqual([]);
});

test('plays normally when Supabase is unreachable', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route('**/rest/v1/**', (route) => route.abort('connectionrefused'));
  const errors: string[] = [], warnings: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'warning' && m.text().includes('[telemetry]') && warnings.push(m.text()));

  await page.goto('/?seed=77&dpr=1&post=0&rooms=3&mute=1');
  await page.evaluate(() => (window as any).__WHACK__.begin({ telemetry: null }));
  await waitForRoom(page, 0);
  const exit = (await W(page)).room.doors.find((d: any) => !d.entrance);
  await page.evaluate((id) => (window as any).__WHACK__.useDoor(id), exit.id);
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as any).__WHACK__.interact());
  await waitForRoom(page, 1);
  expect(warnings.length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
