import { describe, it, expect } from 'vitest'
import { codexPermissions } from './session'

/**
 * Codex splits one permission mode into a sandbox and an approval policy, and
 * the two are not independent: under `approvalPolicy: 'never'` Codex refuses
 * every MCP tool call rather than running it, with "MCP tool call requires
 * approval, but approval policy is never".
 *
 * That is fine where the sandbox already allows everything — nothing needs to
 * ask — and fatal anywhere else, because the browser reaches the agent as an
 * MCP server. Measured against codex-cli 0.151.0 with a probe MCP server:
 * danger-full-access + never called the tool; read-only + never refused it.
 */
describe('codex permissions', () => {
  it('lets the browser work in the default mode', () => {
    const p = codexPermissions('bypassPermissions')
    expect(p.sandbox).toBe('danger-full-access')
    // Nothing to approve when the sandbox allows it outright.
    expect(p.approvalPolicy).toBe('never')
  })

  /** The bug this file exists for: reading a page is the thing you most want
   *  while planning, and 'never' made it impossible. */
  it('lets a plan look things up', () => {
    const p = codexPermissions('plan')
    expect(p.sandbox).toBe('read-only')
    expect(p.approvalPolicy).not.toBe('never')
  })

  it('keeps plan mode read-only, which is what makes it a plan', () => {
    expect(codexPermissions('plan').sandbox).toBe('read-only')
  })

  /**
   * The rule, stated once: a mode whose sandbox is not danger-full-access must
   * be able to ask, or every browser call in it dies.
   */
  it('never pairs a restricted sandbox with a policy that cannot ask', () => {
    for (const mode of ['ask', 'acceptEdits', 'plan', 'bypassPermissions'] as const) {
      const p = codexPermissions(mode)
      if (p.sandbox !== 'danger-full-access') {
        expect(p.approvalPolicy, `${mode} would refuse every MCP tool call`).not.toBe('never')
      }
    }
  })
})
