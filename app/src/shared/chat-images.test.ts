import { describe, expect, it } from 'vitest'
import {
  chatImageRefs,
  dataUrlParts,
  dayLabel,
  freeName,
  imagesByDay,
  markdownImages,
  spacedImagePaths,
  stampedName
} from './chat-images'

describe('the pictures in a conversation', () => {
  it('lists what the user attached, what a tool returned and what the agent showed, in order', () => {
    const refs = chatImageRefs([
      {
        kind: 'msg',
        msg: { id: 'u1', role: 'user', text: 'look', images: ['data:a', 'data:b'], at: 1 }
      },
      { kind: 'tool', tool: { id: 't1', imageCount: 1 } },
      { kind: 'tool', tool: { id: 't2' } },
      {
        kind: 'msg',
        msg: { id: 'a1', role: 'assistant', text: 'Here: ![the header](shots/h.png) done', at: 2 }
      },
      { kind: 'msg', msg: { id: 'u2', role: 'user', text: 'from the phone', imageCount: 2 } },
      { kind: 'diff' }
    ])
    expect(refs.map((r) => r.key)).toEqual(['u1:0', 'u1:1', 't1:0', 'a1:md:0', 'u2:0', 'u2:1'])
    expect(refs[0]).toMatchObject({ kind: 'data', from: 'you', src: 'data:a' })
    expect(refs[2]).toMatchObject({ kind: 'remote', from: 'agent', id: 't1', index: 0 })
    expect(refs[3]).toMatchObject({ kind: 'path', src: 'shots/h.png', alt: 'the header' })
    expect(refs[4]).toMatchObject({ kind: 'remote', from: 'you', id: 'u2' })
  })
  it('does not ask the Mac for bytes it already has, or count a notice of the app', () => {
    const refs = chatImageRefs([
      { kind: 'msg', msg: { id: 'u', role: 'user', text: '', images: ['data:a'], imageCount: 1 } },
      { kind: 'msg', msg: { id: 's', role: 'assistant', text: '![x](y.png)', system: true } }
    ])
    expect(refs).toHaveLength(1)
  })
  it('reads images out of Markdown, but not out of code', () => {
    expect(
      markdownImages(
        'A ![one](a.png) and ![two](</tmp/with space.png> "title").\n```md\n![no](code.png)\n```\nand `![no](inline.png)`'
      )
    ).toEqual([
      { alt: 'one', src: 'a.png' },
      { alt: 'two', src: '/tmp/with space.png' }
    ])
    expect(markdownImages('a [link](x.png), not an image')).toEqual([])
  })
})

describe('saving a picture', () => {
  it('takes a data URL apart, and refuses what is not a picture', () => {
    expect(dataUrlParts('data:image/png;base64,AAAA')).toEqual({
      mediaType: 'image/png',
      ext: 'png',
      base64: 'AAAA'
    })
    expect(dataUrlParts('data:image/jpeg;base64,/9j/')?.ext).toBe('jpg')
    expect(dataUrlParts('data:text/html;base64,AAAA')).toBeNull()
    expect(dataUrlParts('https://example.com/a.png')).toBeNull()
  })
  it('never writes over a file: the name gets a number', () => {
    expect(freeName([], 'shot.png')).toBe('shot.png')
    expect(freeName(['shot.png'], 'shot.png')).toBe('shot 2.png')
    expect(freeName(['Shot.PNG', 'shot 2.png'], 'shot.png')).toBe('shot 3.png')
    expect(freeName(['notes'], 'notes')).toBe('notes 2')
    expect(freeName([], '../etc/passwd')).toBe('..-etc-passwd')
  })
  it('names a picture that has no file by when it was saved', () => {
    expect(stampedName('png', new Date(2026, 9, 10, 9, 5, 7))).toBe(
      'Superagent 2026-10-10 at 09.05.07.png'
    )
  })
})

describe('pictures by the day they arrived', () => {
  const now = new Date(2026, 9, 10, 15, 0).getTime()
  const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m, d, h).getTime()
  it('names the day the way a person would', () => {
    expect(dayLabel(at(2026, 9, 10, 9), now)).toBe('Today')
    expect(dayLabel(at(2026, 9, 9, 23), now)).toBe('Yesterday')
    expect(dayLabel(at(2026, 9, 7), now)).toBe('Wednesday')
    expect(dayLabel(at(2026, 8, 2), now)).toBe('2 September')
    expect(dayLabel(at(2025, 11, 24), now)).toBe('24 December 2025')
    expect(dayLabel(undefined, now)).toBe('Earlier')
  })
  it('puts the newest first, in runs of the same day', () => {
    const pic = (key: string, t?: number): never =>
      ({ kind: 'data', key, from: 'you', src: 'data:x', at: t }) as never
    const groups = imagesByDay(
      [
        pic('old'),
        pic('a', at(2026, 9, 9)),
        pic('b', at(2026, 9, 10, 8)),
        pic('c', at(2026, 9, 10, 9))
      ],
      now
    )
    expect(groups.map((g) => [g.day, g.images.map((i) => i.key)])).toEqual([
      ['Today', ['c', 'b']],
      ['Yesterday', ['a']],
      ['Earlier', ['old']]
    ])
  })
})

describe('a picture whose path has a space in it', () => {
  const path = '/Users/me/Library/Application Support/SuperAgent/desktop-chat/floorplan.png'
  it('is put in angle brackets, so markdown reads it as a picture', () => {
    expect(spacedImagePaths(`Here:\n\n![Floor plan: kino top left](${path})\n\nDone.`)).toBe(
      `Here:\n\n![Floor plan: kino top left](<${path}>)\n\nDone.`
    )
    expect(markdownImages(`![plan](${path})`)).toEqual([{ alt: 'plan', src: path }])
    expect(spacedImagePaths('![a](~/My Pictures/a b.png)')).toBe('![a](<~/My Pictures/a b.png>)')
  })
  it('leaves everything else as written', () => {
    for (const same of [
      '![a](/tmp/a.png)',
      `![a](<${path}>)`,
      '![a](/tmp/a.png "A title")',
      '![a](https://x.test/a b.png)',
      `\`![a](${path})\``,
      '```\n![a](/tmp/my file.png)\n```',
      '[a link](/tmp/my file.png)',
      'no pictures here (at all)'
    ])
      expect(spacedImagePaths(same)).toBe(same)
  })
})
