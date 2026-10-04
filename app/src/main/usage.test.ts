import { describe, it, expect } from 'vitest'
import {
  usageFromClaudeApi,
  usageFromClaudeEvent,
  usageFromAntigravity,
  usageFromClaudeHeaders,
  usageFromCodex
} from './usage'

const NOW = 1_790_950_000_000

describe('usageFromClaudeEvent', () => {
  it('reads every window a turn reports, as percents', () => {
    // As the CLI sends it (2.1.x, stream-json).
    const event = {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        resetsAt: 1791230400,
        rateLimitType: 'seven_day',
        utilization: 0.86,
        unifiedWindows: {
          five_hour: { utilization: 0.5, resetsAt: 1790956800 },
          seven_day: { utilization: 0.86, resetsAt: 1791230400 }
        }
      }
    }
    expect(usageFromClaudeEvent(event, NOW)).toEqual({
      windows: [
        { label: '5-hour', percent: 50, resetsAt: 1790956800_000 },
        { label: 'Weekly', percent: 86, resetsAt: 1791230400_000 }
      ],
      at: NOW
    })
  })

  it('falls back to the one window an older CLI names', () => {
    const event = {
      type: 'rate_limit_event',
      rate_limit_info: { utilization: 0.91, rateLimitType: 'five_hour', resetsAt: 1790956800 }
    }
    expect(usageFromClaudeEvent(event, NOW)?.windows).toEqual([
      { label: '5-hour', percent: 91, resetsAt: 1790956800_000 }
    ])
  })

  it('has nothing to say about any other event, or one with no numbers', () => {
    expect(usageFromClaudeEvent({ type: 'assistant' }, NOW)).toBeNull()
    expect(
      usageFromClaudeEvent(
        { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
        NOW
      )
    ).toBeNull()
  })
})

describe('usageFromClaudeApi', () => {
  it('reads /api/oauth/usage, leaving out the windows a plan does not have', () => {
    const body = {
      five_hour: { utilization: 48.0, resets_at: '2026-10-02T16:00:00.148236+00:00' },
      seven_day: { utilization: 86.0, resets_at: '2026-10-05T20:00:00.148270+00:00' },
      seven_day_opus: null,
      seven_day_sonnet: null,
      extra_usage: { is_enabled: false }
    }
    expect(usageFromClaudeApi(body, NOW)).toEqual({
      windows: [
        { label: '5-hour', percent: 48, resetsAt: Date.parse('2026-10-02T16:00:00.148Z') },
        { label: 'Weekly', percent: 86, resetsAt: Date.parse('2026-10-05T20:00:00.148Z') }
      ],
      at: NOW
    })
    expect(usageFromClaudeApi({ error: 'nope' }, NOW)).toBeNull()
    expect(usageFromClaudeApi(null, NOW)).toBeNull()
  })
})

describe('usageFromCodex', () => {
  it('names each window by its length', () => {
    // account/rateLimits/read, codex 0.1xx.
    const rateLimits = {
      limitId: 'codex',
      primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 1790966260 },
      secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1791478615 }
    }
    expect(usageFromCodex(rateLimits, NOW)).toEqual({
      windows: [
        { label: '5-hour', percent: 18, resetsAt: 1790966260_000 },
        { label: 'Weekly', percent: 12, resetsAt: 1791478615_000 }
      ],
      at: NOW
    })
    expect(
      usageFromCodex({ primary: { usedPercent: 140, windowDurationMins: 2880 } }, NOW)?.windows
    ).toEqual([{ label: '2-day', percent: 100, resetsAt: null }])
    expect(usageFromCodex({ primary: null, secondary: null }, NOW)).toBeNull()
  })
})

describe('usageFromClaudeHeaders', () => {
  it('reads the windows off the headers every message comes back with', () => {
    // As api.anthropic.com answers a subscription token (October 2026).
    const headers: Record<string, string> = {
      'anthropic-ratelimit-unified-status': 'allowed_warning',
      'anthropic-ratelimit-unified-5h-utilization': '0.15',
      'anthropic-ratelimit-unified-5h-reset': '1791033600',
      'anthropic-ratelimit-unified-7d-utilization': '0.99',
      'anthropic-ratelimit-unified-7d-reset': '1791230400'
    }
    expect(usageFromClaudeHeaders((n) => headers[n], NOW)).toEqual({
      windows: [
        { label: '5-hour', percent: 15, resetsAt: 1791033600_000 },
        { label: 'Weekly', percent: 99, resetsAt: 1791230400_000 }
      ],
      at: NOW
    })
    // An answer with no such headers (an API key, an error page) says nothing.
    expect(usageFromClaudeHeaders(() => null, NOW)).toBeNull()
  })
})

describe('usageFromAntigravity', () => {
  it("reads each model group's weekly limit from agy /usage", () => {
    // As `agy -p /usage --output-format json` answers (agy 1.2.16).
    const out = {
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                {
                  id: 'gemini-weekly',
                  window: 'weekly',
                  remaining_fraction: 0,
                  reset_time: '2026-10-08T12:30:12Z'
                }
              ]
            },
            {
              name: 'Claude and GPT models',
              buckets: [
                {
                  id: '3p-weekly',
                  window: 'weekly',
                  remaining_fraction: 0.75,
                  reset_time: '2026-10-11T20:58:02Z'
                }
              ]
            }
          ]
        }
      }
    }
    expect(usageFromAntigravity(out, NOW)).toEqual({
      windows: [
        { label: 'Gemini weekly', percent: 100, resetsAt: Date.parse('2026-10-08T12:30:12Z') },
        { label: 'Claude/GPT weekly', percent: 25, resetsAt: Date.parse('2026-10-11T20:58:02Z') }
      ],
      at: NOW
    })
    expect(usageFromAntigravity({ status: 'SUCCESS', response: 'hi' }, NOW)).toBeNull()
    expect(usageFromAntigravity(null, NOW)).toBeNull()
  })
})
