import { describe, it, expect } from 'vitest'
import { replyingTo, splitLeadingQuote } from './reply-quote'

const said = ['make the header sticky', 'also why is the build so slow?', 'ok ship it']

describe('a reply that quotes the message it answers', () => {
  it('lifts the quote off the front when it is something the user said', () => {
    expect(replyingTo('> also why is the build so slow?\n\nIt rebuilds the image.', said)).toEqual({
      quote: 'also why is the build so slow?',
      rest: 'It rebuilds the image.'
    })
  })

  it('accepts a shortened quote, an ellipsis, other case and stray quote marks', () => {
    expect(replyingTo('> "Why is the build so slow…"\nBecause.', said)?.quote).toBe(
      'Why is the build so slow'
    )
    expect(replyingTo('> make the header\n> sticky\n\nDone.', said)?.rest).toBe('Done.')
  })

  it('leaves a quote of anything else as an ordinary blockquote', () => {
    expect(replyingTo('> error: ENOENT no such file\n\nThat is the cause.', said)).toBeNull()
    expect(replyingTo('No quote here.', said)).toBeNull()
  })

  it('needs an answer after the quote, and a quote worth the name', () => {
    expect(replyingTo('> ok ship it', said)).toBeNull()
    expect(replyingTo('> a\n\nYes.', ['a'])).toBeNull()
    expect(splitLeadingQuote('>\n\ntext')).toBeNull()
  })

  it('only looks at the very start: a quote further down stays where it is', () => {
    expect(replyingTo('First.\n\n> ok ship it\n\nShipped.', said)).toBeNull()
  })

  it('works while the reply is still streaming in', () => {
    // The quote alone is not yet a reply; once words follow, it is.
    expect(replyingTo('> ok ship', said)).toBeNull()
    expect(replyingTo('> ok ship it\n\nShip', said)).toEqual({ quote: 'ok ship it', rest: 'Ship' })
  })
})
