import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({
  prefs: { done: true, needsYou: true },
  devices: [
    { id: 'a', pushToken: 'aa'.repeat(32), pushEnv: 'production' },
    { id: 'b', pushToken: 'bb'.repeat(32), pushEnv: 'sandbox' },
    { id: 'c', pushToken: null, pushEnv: 'production' }
  ]
}))
vi.mock('./devices', () => ({ devicesWithPush: () => h.devices.filter((d) => d.pushToken) }))
vi.mock('../hooks', () => ({ notifyPrefs: h.prefs }))
vi.mock('../store', () => ({
  getWorkspaceName: (id: string) => (id === 'w1' ? 'rowfill' : undefined)
}))

import { composePush, pushTargets } from './push'

describe('push', () => {
  it('composes an approval as a time-sensitive alert with the APPROVAL category', () => {
    const { payload, collapseId } = composePush({
      kind: 'approval',
      workspaceId: 'w1',
      chatId: 'c1',
      approvalId: 'gate-3',
      detail: 'rm -rf build',
      machineName: 'Studio Mac'
    })
    const aps = payload.aps as Record<string, unknown>
    expect(aps.alert).toEqual({
      title: 'Claude wants to act',
      subtitle: 'Studio Mac · rowfill',
      body: 'rm -rf build'
    })
    expect(aps.category).toBe('APPROVAL')
    expect(aps['interruption-level']).toBe('time-sensitive')
    expect(aps['thread-id']).toBe('c1')
    expect(payload.sa).toEqual({
      kind: 'approval',
      chatId: 'c1',
      workspaceId: 'w1',
      approvalId: 'gate-3'
    })
    expect(collapseId).toBe('gate-3')
  })

  it('composes done and needs-you with sensible defaults', () => {
    const done = composePush({ kind: 'done', machineName: 'Mac', detail: 'Pushed v1.2' })
    expect((done.payload.aps as { alert: { body: string; title: string } }).alert).toMatchObject({
      title: 'Claude is done',
      body: 'Pushed v1.2'
    })
    const needs = composePush({ kind: 'needs-you', machineName: 'Mac' })
    expect((needs.payload.aps as { alert: { body: string } }).alert.body).toBe(
      'The agent is waiting for your input.'
    )
  })

  it('targets devices with a token that are not on screen, honoring the banner prefs', () => {
    expect(pushTargets('approval', new Set()).map((t) => t.deviceId)).toEqual(['a', 'b'])
    expect(pushTargets('approval', new Set(['a'])).map((t) => t.deviceId)).toEqual(['b'])
    expect(pushTargets('done', new Set()).find((t) => t.deviceId === 'b')?.env).toBe('sandbox')
    h.prefs.done = false
    expect(pushTargets('done', new Set())).toEqual([])
    h.prefs.needsYou = false
    expect(pushTargets('approval', new Set())).toEqual([])
  })

  it('composes a test banner and never fans it out', () => {
    const { payload } = composePush({ kind: 'test', machineName: 'Mac' })
    expect(payload).toMatchObject({
      aps: { alert: { title: 'Notifications are on' }, category: 'DONE' },
      sa: { kind: 'test' }
    })
    expect(pushTargets('test', new Set())).toEqual([])
  })
})
