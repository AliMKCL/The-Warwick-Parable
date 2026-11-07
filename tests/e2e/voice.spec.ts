import { expect, test } from '@playwright/test';

// Run with the mock server standing in for ElevenLabs:
// ELEVENLABS_API_KEY=test ELEVENLABS_BASE_URL=http://127.0.0.1:11999 LLM_BASE_URL=http://127.0.0.1:11999
test('the narrator speaks through the /tts proxy', async ({ page }) => {
  test.skip(!process.env.ELEVENLABS_API_KEY, 'needs ELEVENLABS_API_KEY (the mock accepts any)');
  test.setTimeout(120_000);
  const tts: string[] = [];
  page.on('request', (r) => r.url().includes('/tts') && tts.push(r.postData() ?? ''));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 800, height: 450 });
  await page.goto('/?seed=5&dpr=1&post=0');
  await expect(page.locator('#status-voice')).toHaveText(/ElevenLabs/);
  await page.evaluate(() => (window as any).__WHACK__.begin());
  await page.waitForFunction(() => (window as any).__WHACK__.state().room?.index === 0, null, { timeout: 60_000 });
  await page.waitForTimeout(3000);
  expect(tts.length).toBeGreaterThan(0);
  const body = JSON.parse(tts[0]!);
  expect(body.text.length).toBeGreaterThan(10);
  expect(body.model_id).toBe('eleven_flash_v2_5');
  expect(body).not.toHaveProperty('xi_api_key'); // the key is added by the dev server, never by the page
  const st = await page.evaluate(() => (window as any).__WHACK__.state());
  expect(st.voice.error).toBeUndefined();
  expect(errors).toEqual([]);
});
