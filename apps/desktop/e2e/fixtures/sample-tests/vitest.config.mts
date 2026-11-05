import { defineConfig } from 'vitest/config'

// Fixture project for the Tests panel (unit and end-to-end tests of vibe-coding-ide).
// Its files use *.check.ts / *.pw.ts so the repository's own test runs ignore them.
export default defineConfig({
  test: { include: ['unit/**/*.check.ts'] }
})
