import { describe, it, expect } from 'vitest'
import { newTokens, processedTokens } from './token-usage'

describe('token usage', () => {
  // The totals of a real 104-request chat.
  const chat = {
    input_tokens: 216,
    cache_read_input_tokens: 20_268_841,
    cache_creation_input_tokens: 675_733,
    output_tokens: 86_596
  }

  it('leaves the re-read conversation out of what was used', () => {
    expect(newTokens(chat)).toBe(762_545)
  })

  it('still knows the full amount processed', () => {
    expect(processedTokens(chat)).toBe(21_031_386)
  })

  it('reads missing fields as zero', () => {
    expect(newTokens({})).toBe(0)
    expect(processedTokens({ output_tokens: 5 })).toBe(5)
  })
})
