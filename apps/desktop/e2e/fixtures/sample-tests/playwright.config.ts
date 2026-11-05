import { defineConfig } from '@playwright/test'

// Fixture project for the Tests panel: plain tests, no browser needed.
export default defineConfig({
  testDir: 'pw',
  testMatch: '**/*.pw.ts',
  reporter: 'list'
})
