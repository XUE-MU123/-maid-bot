import { defineConfig, devices } from '@playwright/test';

/** Tests an explicitly served panel; set TEST_BASE_URL for an isolated preview. All APIs are mocked. */
export default defineConfig({
  testDir: './tests/browser',
  outputDir: './test-results/artifacts',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:3210').origin,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
