import { defineConfig } from '@playwright/test'

// E2E smoke suite drives the built Electron app. Run `npm run build` first.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure'
  }
})
