import { describe, expect, it } from 'vitest'
import { computerBeforeShell, computerShellVerdict } from './computer-guard'

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
      `sqlite3 ~/Library/Application\\ Support/com.apple.TCC/TCC.db "update access set auth_value=2"`
    ])
      expect(computerShellVerdict(cmd), cmd).toMatch(/^Blocked by Superagent/)
  })
  it('leaves ordinary commands alone, including ones that only mention the words', () => {
    for (const cmd of [
      'git status',
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
