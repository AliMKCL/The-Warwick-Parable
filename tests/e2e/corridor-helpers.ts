import type { Page } from '@playwright/test';

export const state = (page: Page) => page.evaluate(() => (window as any).__WHACK__.state());
const directions: Record<string, number[]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };

export async function stepThrough(page: Page) {
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(950);
  await page.keyboard.up('KeyW');
}

/** Existing room tests skip the long walk, but still cross both physical thresholds with collision. */
export async function traversePassage(page: Page) {
  if (!(await state(page)).corridor) return; // the final exit goes to the dossier
  await stepThrough(page);
  await page.waitForFunction(() => (window as any).__WHACK__.state().corridor?.entered);
  if ((await state(page)).ended) return;
  await leavePassage(page);
}

export async function leavePassage(page: Page) {
  const s = await state(page), c = s.corridor;
  const door = c.layout.doors.find((d: any) => !d.entrance);
  const [dx, dz] = directions[door.side]!;
  const x = c.x + door.cx + 0.5 + dx! * 0.5, z = c.z + door.cz + 0.5 + dz! * 0.5;
  await page.evaluate(({ x, z, dx, dz }) => (window as any).__WHACK__.lookFrom(x - dx * 0.85, z - dz * 0.85, x, 1.2, z), { x, z, dx: dx!, dz: dz! });
  await page.waitForFunction(() => (window as any).__WHACK__.state().hovered?.id === 'onward');
  await page.evaluate(() => (window as any).__WHACK__.interact());
  await page.waitForFunction(() => (window as any).__WHACK__.state().corridor?.exitOpen > 0.85);
  await stepThrough(page);
  await page.waitForFunction((index) => {
    const s = (window as any).__WHACK__.state();
    return s.ended || s.room?.index === index + 1;
  }, s.room.index);
}

/** Walk the corridor's complete centre route using WASD, including both bends. */
export async function walkPassage(page: Page) {
  const s = await state(page), c = s.corridor;
  const goal = c.layout.doors.find((d: any) => !d.entrance);
  const start = [Math.floor(s.player.x - c.x), Math.floor(s.player.z - c.z)];
  const queue = [start], previous = new Map<string, number[] | null>([[start.join(','), null]]);
  while (queue.length) {
    const at = queue.shift()!;
    if (at[0] === goal.cx && at[1] === goal.cz) break;
    for (const [dx, dz] of Object.values(directions)) {
      const next = [at[0]! + dx!, at[1]! + dz!], key = next.join(',');
      if (c.layout.cells[next[1]!]?.[next[0]!] !== '.' || previous.has(key)) continue;
      previous.set(key, at);
      queue.push(next);
    }
  }
  let at: number[] | null = [goal.cx, goal.cz];
  const path: number[][] = [];
  while (at) { path.unshift(at); at = previous.get(at.join(',')) ?? null; }
  // Combine straight portions, keeping a waypoint at each corner.
  const corners = path.filter((p, i) => i === 0 || i === path.length - 1 ||
    (p[0]! - path[i - 1]![0]!) !== (path[i + 1]![0]! - p[0]!) ||
    (p[1]! - path[i - 1]![1]!) !== (path[i + 1]![1]! - p[1]!));
  for (const p of corners) {
    const x = c.x + p[0]! + 0.5, z = c.z + p[1]! + 0.5;
    await page.evaluate(({ x, z }) => {
      const w = (window as any).__WHACK__, p = w.state().player;
      w.lookFrom(p.x, p.z, x, 1.62, z);
    }, { x, z });
    await page.keyboard.down('KeyW');
    try {
      await page.waitForFunction(({ x, z }) => {
        const p = (window as any).__WHACK__.state().player;
        return Math.hypot(p.x - x, p.z - z) < 0.16;
      }, { x, z }, { timeout: 15000 });
    } finally { await page.keyboard.up('KeyW'); }
  }
}
