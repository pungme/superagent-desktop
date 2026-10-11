import { describe, expect, it } from 'vitest'
import { computerBeforeShell, computerBeforeWrite, computerShellVerdict } from './computer-guard'

describe("the agent's shell is not a second way to the mouse, keyboard or screen", () => {
  it('refuses the known routes', () => {
    for (const cmd of [
      '/Applications/SuperAgent.app/Contents/Resources/cuse click 10 10',
      'cd native && ./cuse type "hello"',
      '"/Applications/SuperAgent.app/Contents/Resources/cuse" click 5 5',
      "'/usr/sbin/screencapture' -x a.png",
      `osascript -e 'tell application "System Events" to keystroke "q" using command down'`,
      `osascript -e 'tell application "System Events" to click button "Allow" of window 1 of process "SuperAgent"'`,
      `osascript -l JavaScript -e 'Application("System Events").keystroke("x")'`,
      'cliclick c:100,200',
      `python3 -c "import pyautogui; pyautogui.click(5,5)"`,
      `python3 -c "import Quartz; Quartz.CGEventPost(0, e)"`,
      'screencapture -x /tmp/s.png',
      'echo ok && /usr/sbin/screencapture -R0,0,100,100 a.png',
      'tccutil reset Accessibility',
      'pbpaste',
      'pbpaste | head -c 400',
      'x=$(pbpaste); echo $x',
      `sqlite3 ~/Library/Application\\ Support/com.apple.TCC/TCC.db "update access set auth_value=2"`
    ])
      expect(computerShellVerdict(cmd), cmd).toMatch(/^Blocked by Superagent/)
  })
  it('leaves ordinary commands alone, including ones that only mention the words', () => {
    for (const cmd of [
      'git status',
      'git diff | pbcopy',
      'cat notes/pbpaste-usage.md',
      'npm test',
      'ls native/',
      'grep -rn "screencaptures" docs/',
      'cat src/main/excuse.ts',
      'xcrun simctl io 1234 screenshot /tmp/a.png',
      `osascript -e 'display notification "done"'`,
      `osascript -e 'tell application "Finder" to get name of front window'`,
      'clang -o native/cuse.o -c native/cuse.c'
    ])
      expect(computerShellVerdict(cmd), cmd).toBeNull()
  })
  it('only looks at shell commands', () => {
    expect(computerBeforeShell('Edit', { command: 'screencapture x.png' })).toBeNull()
    expect(computerBeforeShell('Bash', { command: 'screencapture x.png' })).toMatch(/Blocked/)
    expect(computerBeforeShell('Bash', {})).toBeNull()
  })
})

describe('a script that would do the same, about to be written', () => {
  it('is something to ask the user about, naming the file', () => {
    const asks = [
      ['Write', { file_path: '/tmp/x.py', content: 'import pyautogui\npyautogui.click(5, 5)' }],
      [
        'Write',
        {
          file_path: '/tmp/x.swift',
          content: 'let e = CGEvent(...)\nCGEventPost(.cghidEventTap, e)'
        }
      ],
      [
        'Edit',
        {
          file_path: '/tmp/a.scpt',
          new_string: 'tell application "System Events" to keystroke "q"'
        }
      ],
      [
        'MultiEdit',
        {
          file_path: '/tmp/s.sh',
          edits: [{ new_string: 'echo hi' }, { new_string: 'screencapture -x /tmp/a.png' }]
        }
      ],
      ['Write', { file_path: '/tmp/t.sh', content: 'tccutil reset All' }]
    ] as const
    for (const [tool, input] of asks) {
      const q = computerBeforeWrite(tool, input)
      expect(q, JSON.stringify(input)).toContain(input.file_path)
      expect(q).toContain('without asking you first')
    }
  })
  it('is nothing for ordinary files, or for what is only being removed', () => {
    expect(
      computerBeforeWrite('Write', { file_path: 'a.ts', content: 'export const x = 1' })
    ).toBeNull()
    expect(
      computerBeforeWrite('Edit', {
        file_path: 'a.c',
        old_string: 'CGEventPost(tap, e)',
        new_string: ''
      })
    ).toBeNull()
    expect(
      computerBeforeWrite('Write', {
        file_path: 'notes.md',
        content: 'take a screenshot of the page'
      })
    ).toBeNull()
    expect(computerBeforeWrite('Bash', { command: 'pyautogui' })).toBeNull()
  })
})
