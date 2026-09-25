import { defineConfig } from '@playwright/test'

// Run without disturbing whoever is at the Mac: the app under test stays
// hidden (no window, Dock icon, notifications or focus) and external browsers
// run headless. See src/main/quiet.ts. COVE_E2E_QUIET=0 to watch a run.
process.env.COVE_E2E_QUIET ??= '1'

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
