import { describe, it, expect } from 'vitest'
import { spawn } from 'child_process'
import { killProcessTree, killProcessTreeForSure, DETACH_FOR_TREE_KILL } from './kill-tree'

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('killProcessTree', () => {
  it.skipIf(process.platform === 'win32')(
    'kills a grandchild process, not just the one Node spawned',
    async () => {
      // A shell that spawns `sleep` as its own child — a stand-in for a Bash
      // tool call spawning a long-running build. Only detaching (as the real
      // agent sessions now do) puts it in its own process group; without
      // that, killing the group would hit this test runner too.
      const proc = spawn('sh', ['-c', 'sleep 30 & echo $! && wait'], {
        detached: DETACH_FOR_TREE_KILL
      })
      const grandchildPid = await new Promise<number>((resolve) => {
        let out = ''
        proc.stdout?.on('data', (c: Buffer) => {
          out += c.toString()
          const n = parseInt(out.trim(), 10)
          if (!Number.isNaN(n)) resolve(n)
        })
      })
      expect(isAlive(grandchildPid)).toBe(true)

      killProcessTree(proc, 'SIGKILL')
      // Give the signal a moment to land.
      await new Promise((r) => setTimeout(r, 300))

      expect(isAlive(grandchildPid)).toBe(false)
    }
  )

  // An agent mid-turn took the polite signal and kept working, unseen.
  it.skipIf(process.platform === 'win32')(
    'ends a process that ignores being asked to stop',
    async () => {
      const proc = spawn('sh', ['-c', 'trap "" TERM; echo ready; while true; do sleep 1; done'], {
        detached: DETACH_FOR_TREE_KILL
      })
      await new Promise<void>((resolve) => proc.stdout?.once('data', () => resolve()))
      const gone = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
      killProcessTreeForSure(proc, 300)
      await new Promise((r) => setTimeout(r, 150))
      expect(isAlive(proc.pid!)).toBe(true) // asked, and still there
      await gone
      expect(proc.signalCode).toBe('SIGKILL')
    },
    10_000
  )
})
