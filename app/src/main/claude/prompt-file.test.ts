import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promptAsFile } from './prompt-file'

describe('promptAsFile', () => {
  it('moves the appended prompt off the command line and into a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-prompt-'))
    try {
      const args = promptAsFile(
        ['-p', '--append-system-prompt', 'build with xcodebuild', '--model', 'opus'],
        dir
      )
      expect(args.join(' ')).not.toContain('xcodebuild')
      const file = args[args.indexOf('--append-system-prompt-file') + 1]
      expect(readFileSync(file, 'utf8')).toBe('build with xcodebuild')
      // Everything else is where it was.
      expect(args.slice(0, 1)).toEqual(['-p'])
      expect(args.slice(-2)).toEqual(['--model', 'opus'])
      // The same prompt is the same file: nothing piles up.
      expect(promptAsFile(['--append-system-prompt', 'build with xcodebuild'], dir)[1]).toBe(file)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves a command line with no appended prompt alone', () => {
    expect(promptAsFile(['-p', '--model', 'opus'])).toEqual(['-p', '--model', 'opus'])
  })
})
