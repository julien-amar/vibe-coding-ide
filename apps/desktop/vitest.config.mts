import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Unit tests: pure logic of the main process, shared modules and renderer helpers.
// End-to-end tests (the real app) live in e2e/ and run with Playwright.
export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The git integration tests create real repositories.
    testTimeout: 30000
  }
})
