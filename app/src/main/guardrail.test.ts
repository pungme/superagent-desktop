import { describe, it, expect, beforeEach } from 'vitest'
import {
  classifyTool,
  gateDecision,
  markTainted,
  clearTurn,
  trustTurn,
  isTainted,
  toolPreview
} from './guardrail'

const S = 'sess-1'

beforeEach(() => {
  clearTurn(S)
  clearTurn('other')
})

describe('classifyTool', () => {
  it('flags the web-read tool as taint', () => {
    expect(classifyTool('mcp__cove-browser__browser_read_page')).toBe('taint')
  })
  it('flags machine-acting tools as gate', () => {
    for (const t of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
      expect(classifyTool(t)).toBe('gate')
  })
  it('leaves read-only / unknown tools as allow', () => {
    for (const t of ['Read', 'Grep', 'Glob', 'mcp__cove-browser__browser_screenshot', 'TodoWrite'])
      expect(classifyTool(t)).toBe('allow')
  })
})

describe('gateDecision', () => {
  it('allows shell when the turn never read the web', () => {
    expect(gateDecision(S, 'Bash')).toBe('allow')
  })
  it('asks for shell once the turn is tainted', () => {
    markTainted(S)
    expect(gateDecision(S, 'Bash')).toBe('ask')
    expect(gateDecision(S, 'Write')).toBe('ask')
  })
  it('never gates read-only tools even when tainted', () => {
    markTainted(S)
    expect(gateDecision(S, 'Read')).toBe('allow')
    expect(gateDecision(S, 'mcp__cove-browser__browser_read_page')).toBe('allow')
  })
  it('stops asking after the user trusts the turn', () => {
    markTainted(S)
    expect(gateDecision(S, 'Bash')).toBe('ask')
    trustTurn(S)
    expect(gateDecision(S, 'Bash')).toBe('allow')
  })
  it('re-arms on a new turn (clearTurn)', () => {
    markTainted(S)
    trustTurn(S)
    clearTurn(S)
    expect(isTainted(S)).toBe(false)
    // A fresh turn that reads the web again must gate again.
    markTainted(S)
    expect(gateDecision(S, 'Bash')).toBe('ask')
  })
  it('keeps taint per-session — one session cannot gate another', () => {
    markTainted(S)
    expect(gateDecision('other', 'Bash')).toBe('allow')
  })
})

describe('toolPreview', () => {
  it('shows the shell command', () => {
    expect(toolPreview('Bash', { command: 'rm -rf /tmp/x' })).toBe('rm -rf /tmp/x')
  })
  it('names the file for writes/edits', () => {
    expect(toolPreview('Write', { file_path: '/a/b.ts' })).toBe('Write /a/b.ts')
    expect(toolPreview('Edit', { file_path: '/a/b.ts' })).toBe('Edit /a/b.ts')
  })
  it('degrades gracefully on missing input', () => {
    expect(toolPreview('Bash', {})).toBe('(shell command)')
    expect(toolPreview('Bash', undefined)).toBe('(shell command)')
  })
})
