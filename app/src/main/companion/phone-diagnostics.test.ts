import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  savePhoneDiagnostic,
  reportFileName,
  KEEP_REPORTS,
  MAX_REPORT_BYTES
} from './phone-diagnostics'

describe('phone diagnostics', () => {
  it('stores a hang report the phone sends, under a safe name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdiag-'))
    const body = JSON.stringify({ chatId: 'c1', seconds: 4.2 })
    const r = savePhoneDiagnostic(dir, '../iPhone Duo/x', { kind: 'hang', id: 'a/b', body }, 0)
    expect(r.ok).toBe(true)
    const [f] = readdirSync(dir)
    expect(f).toBe('1970-01-01T00-00-00-000Z_-iPhone-Duo-x_hang_a-b.json')
    expect(readFileSync(join(dir, f), 'utf8')).toBe(body)
  })

  it('refuses what is not a report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdiag-'))
    expect(savePhoneDiagnostic(dir, 'd', { kind: 'other', id: 'x', body: '{}' }).ok).toBe(false)
    expect(savePhoneDiagnostic(dir, 'd', { kind: 'hang', id: 'x', body: 'not json' }).ok).toBe(
      false
    )
    expect(
      savePhoneDiagnostic(dir, 'd', {
        kind: 'hang',
        id: 'x',
        body: `"${'x'.repeat(MAX_REPORT_BYTES)}"`
      }).ok
    ).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('keeps only the newest reports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdiag-'))
    for (let i = 0; i < KEEP_REPORTS + 5; i++)
      savePhoneDiagnostic(dir, 'd', { kind: 'hang', id: `h${i}`, body: '{}' }, i * 1000)
    expect(readdirSync(dir)).toHaveLength(KEEP_REPORTS)
    expect(reportFileName('d', 'hang', 'x', 0)).toMatch(/^1970-01-01/)
  })
})
