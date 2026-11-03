import { describe, it, expect } from 'vitest'
import { parseDescription } from './skills'

describe('parseDescription', () => {
  it('reads the description from frontmatter', () => {
    const md = `---
name: check-my-site
description: Open the preview and click through the flows
---

# Check my site

Body text here.`
    expect(parseDescription(md)).toBe('Open the preview and click through the flows')
  })

  it('strips surrounding quotes from a quoted description', () => {
    const md = `---
description: "A quoted description"
---
body`
    expect(parseDescription(md)).toBe('A quoted description')
  })

  it('falls back to the first non-heading line when no description', () => {
    const md = `# My Command

This runs the thing.`
    expect(parseDescription(md)).toBe('This runs the thing.')
  })

  it('handles a plain body with no frontmatter and no heading', () => {
    expect(parseDescription('Just a one liner.')).toBe('Just a one liner.')
  })

  it('truncates very long descriptions', () => {
    const long = 'x'.repeat(300)
    expect(parseDescription(`---\ndescription: ${long}\n---`).length).toBe(140)
  })
})

describe('skills from the claude.ai account', () => {
  it('lists what Claude Code synced, once each, and your own skill of the same name wins', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const home = mkdtempSync(join(tmpdir(), 'cove-synced-'))
    const was = process.env.HOME
    process.env.HOME = home
    try {
      const skill = (dir: string, name: string, desc: string): void => {
        mkdirSync(join(dir, name), { recursive: true })
        writeFileSync(
          join(dir, name, 'SKILL.md'),
          `---\nname: ${name}\ndescription: ${desc}\n---\n`
        )
      }
      const synced = join(home, '.claude', 'skills', 'synced')
      skill(join(synced, 'org1_user1'), 'instantly-outreach', 'From claude.ai')
      skill(join(synced, 'org1_user1'), 'pdf', 'From claude.ai')
      skill(join(synced, 'org2_user2'), 'pdf', 'From claude.ai too')
      writeFileSync(join(synced, 'org1_user1', 'manifest.json'), '{}')
      skill(join(home, '.claude', 'skills'), 'pdf', 'Mine')
      const { discoverSkills } = await import('./skills')
      const list = discoverSkills()
      expect(list.map((s) => [s.name, s.scope, s.description])).toEqual([
        ['instantly-outreach', 'claude.ai', 'From claude.ai'],
        ['pdf', 'global', 'Mine']
      ])
    } finally {
      process.env.HOME = was
      rmSync(home, { recursive: true, force: true })
    }
  })
})
