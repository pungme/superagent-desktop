import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // index: the app. sim-input-worker: the simulator's input, in a process
        // of its own so a finger on it never waits behind main.
        input: {
          index: resolve('src/main/index.ts'),
          'sim-input-worker': resolve('src/main/sim-input-worker.ts')
        },
        // ws is a runtime dependency (shipped in node_modules); its optional native
        // accelerators must not be resolved at bundle time.
        external: ['ws', 'bufferutil', 'utf-8-validate']
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        // index: the app window's bridge. pane: the browser pane's own, tiny
        // preload (the Firefox identity on Google's sign-in pages).
        input: {
          index: resolve('src/preload/index.ts'),
          pane: resolve('src/preload/pane.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
