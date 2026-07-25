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
