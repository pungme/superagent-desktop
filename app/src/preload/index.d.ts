import { ElectronAPI } from '@electron-toolkit/preload'
import type { CoveApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    cove: CoveApi
  }
}
