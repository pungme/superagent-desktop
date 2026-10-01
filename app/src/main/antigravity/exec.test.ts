import { describe, it, expect, vi } from 'vitest'

vi.mock('../claude-cli', () => ({ findAgy: () => 'agy' }))

const { agyRunArgs, lastLine, parseAgyModels } = await import('./exec')
const { stepsFromEvent, tokensFromEvents } = await import('./routine')

/** The value that follows a flag, or undefined when the flag isn't there. */
function valuesAfter(args: string[], flag: string): string[] {
  return args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []))
}

describe('agy models', () => {
  it('reads one model per line, with the tier as the hint', () => {
    const out = [
      'gemini-3.8-flash-high     Gemini 3.8 Flash (High)',
      'gemini-3.1-pro-low        Gemini 3.1 Pro (Low)',
      'claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)',
      'gpt-oss-120b-medium       GPT-OSS 120B (Medium)'
    ].join('\n')
    expect(parseAgyModels(out)).toEqual([
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash', hint: 'High' },
      { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro', hint: 'Low' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: 'Thinking' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B', hint: 'Medium' }
    ])
  })

  it('reads the tab-separated form agy prints when it is not on a terminal', () => {
    // What agy 1.2.14 really writes into a pipe, which is how the app runs it.
    const out =
      'Fetching available models...\n' +
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n' +
      'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n'
    expect(parseAgyModels(out)).toEqual([
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash', hint: 'High' },
      { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6', hint: 'Thinking' }
    ])
  })

  it('finds no models in what a signed-out CLI prints', () => {
    const out =
      'Fetching available models...\n' +
      'Error: Please sign in to view available models. Launch the CLI without arguments to sign in.'
    expect(parseAgyModels(out)).toEqual([])
  })
})

describe('a one-shot run', () => {
  it('streams both ways and points the tools at the project', () => {
    const args = agyRunArgs({ cwd: '/work' })
    expect(valuesAfter(args, '--input-format')).toEqual(['stream-json'])
    expect(valuesAfter(args, '--output-format')).toEqual(['stream-json'])
    expect(valuesAfter(args, '--add-dir')).toEqual(['/work'])
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('approves everything only when asked to, as a routine does', () => {
    const args = agyRunArgs({ cwd: '/work', addDirs: ['/side'], skipPermissions: true })
    expect(args).toContain('--dangerously-skip-permissions')
    expect(valuesAfter(args, '--add-dir')).toEqual(['/work', '/side'])
  })

  it('never passes the prompt as an argument', () => {
    expect(agyRunArgs({ cwd: '/work' })).not.toContain('-p')
  })

  it('takes the last thing stderr said, without its marker', () => {
    expect(lastLine("error: authentication required. Run 'agy' to log in, then retry.\n")).toBe(
      "authentication required. Run 'agy' to log in, then retry."
    )
    expect(lastLine('one\nAGY_ERROR: {"status":"UNAVAILABLE"}\n')).toBe('one')
    expect(lastLine('')).toBe('')
  })
})

describe('a routine transcript', () => {
  it('reads tools under the short names the other runners use', () => {
    const steps = stepsFromEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'agy-1',
            name: 'mcp__cove-browser__browser_navigate',
            input: { url: 'https://example.com' }
          },
          { type: 'text', text: 'Done.' }
        ]
      }
    })
    expect(steps).toEqual([
      { kind: 'tool', name: 'browser_navigate', input: '{"url":"https://example.com"}' },
      { kind: 'text', text: 'Done.' }
    ])
  })

  it('counts what the run spent off its result', () => {
    expect(
      tokensFromEvents([
        { type: 'assistant', message: {} },
        {
          type: 'result',
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 }
        }
      ])
    ).toBe(125)
    expect(tokensFromEvents([])).toBe(0)
  })
})
