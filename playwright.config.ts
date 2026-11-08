import { defineConfig, devices } from '@playwright/test';

// Uses an installed Chrome when CHROME_PATH is set (Claude's test machine);
// otherwise run `npx playwright install chromium` once.
const executablePath = process.env.CHROME_PATH;
// PORT picks another dev-server port, e.g. when another checkout is already serving 5188.
const port = Number(process.env.PORT) || 5188;

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: port === 5188 ? 'npm run dev' : `npx vite --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        launchOptions: executablePath
          ? { executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }
          : {},
      },
    },
  ],
});
