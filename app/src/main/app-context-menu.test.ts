import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', on: () => undefined, whenReady: () => Promise.resolve() },
  BrowserWindow: class {},
  WebContentsView: class {},
  Menu: { buildFromTemplate: () => ({ popup: () => undefined }) },
  clipboard: { writeText: () => undefined },
  dialog: {},
  ipcMain: { on: () => undefined, handle: () => undefined },
  nativeImage: {},
  screen: {},
  session: { fromPartition: () => ({}) },
  shell: {},
  net: {},
  protocol: {}
}))

import { appContextTemplate } from './browser'

const wc = {
  copyImageAt: vi.fn(),
  cut: vi.fn(),
  copy: vi.fn(),
  paste: vi.fn(),
  selectAll: vi.fn()
}
const flags = { canCut: true, canCopy: true, canPaste: false, canSelectAll: true } as never
const base = {
  linkURL: '',
  mediaType: 'none' as const,
  srcURL: '',
  x: 10,
  y: 20,
  isEditable: false,
  editFlags: flags,
  selectionText: ''
}
const labels = (t: { label?: string }[]): string[] => t.map((i) => i.label ?? '—')

describe("the app window's right-click menu", () => {
  it('offers to copy or save an image in a conversation', () => {
    const save = vi.fn()
    const t = appContextTemplate(
      wc,
      { ...base, mediaType: 'image', srcURL: 'data:image/png;base64,AAA' },
      save
    )
    expect(labels(t)).toEqual(['Save Image As…', 'Copy Image'])
    t[0].click?.({} as never, undefined as never, {} as never)
    expect(save).toHaveBeenCalledWith('data:image/png;base64,AAA')
    t[1].click?.({} as never, undefined as never, {} as never)
    expect(wc.copyImageAt).toHaveBeenCalledWith(10, 20)
  })
  it('an image from the web has an address worth copying too', () => {
    const t = appContextTemplate(
      wc,
      { ...base, mediaType: 'image', srcURL: 'https://x.test/a.png' },
      () => {}
    )
    expect(labels(t)).toEqual(['Save Image As…', 'Copy Image', 'Copy Image Address'])
  })
  it('a text field gets cut, copy, paste and select all', () => {
    const t = appContextTemplate(wc, { ...base, isEditable: true }, () => {})
    expect(labels(t)).toEqual(['Cut', 'Copy', 'Paste', '—', 'Select All'])
    expect(t[2].enabled).toBe(false)
  })
  it('selected text gets copy, and nothing else is offered on nothing', () => {
    expect(labels(appContextTemplate(wc, { ...base, selectionText: 'hello' }, () => {}))).toEqual([
      'Copy'
    ])
    expect(appContextTemplate(wc, base, () => {})).toEqual([])
  })
})
