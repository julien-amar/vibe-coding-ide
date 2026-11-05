import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests: the built app (out/) is launched with Playwright's Electron
 * support, each test in its own throwaway profile (DEVHUB_USER_DATA).
 * Run `pnpm build` first.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // One Electron app at a time: tests drive real shells and git repositories.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
})
