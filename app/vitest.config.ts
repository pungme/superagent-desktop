import { defineConfig } from 'vitest/config'

// Unit tests only (*.test.ts). E2E specs (e2e/*.spec.ts) run under Playwright.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'out/**', 'dist/**']
  }
})
