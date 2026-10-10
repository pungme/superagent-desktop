import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * A record of what agents did with the Mac: every look and every action, with
 * when, in which conversation and in which app. It is what answers "what did
 * it do while I was away?", and it is kept whether or not anyone reads it.
 *
 * What was typed is not kept, only that something was (it may have been
 * private); what a control was called is.
 */

export interface ComputerLogEntry {
  at: number
  /** The conversation (chat id, or its pane when it has none). */
  owner: string
  /** In words: "Clicked at 120, 60", "Pressed "Save"", "Looked at the screen". */
  what: string
  /** The app it was done in, when known. */
  app?: string
  /** Refused or asked about, rather than done. */
  kind?: 'did' | 'looked' | 'refused'
}

const KEEP = 2000

function file(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'computer-use.log.jsonl')
}

export function noteComputer(entry: Omit<ComputerLogEntry, 'at'> & { at?: number }): void {
  try {
    appendFileSync(file(), JSON.stringify({ at: Date.now(), kind: 'did', ...entry }) + '\n')
  } catch {
    // A record that cannot be written must not stop the work it records.
  }
}

/** The lines of the record, oldest first; a line that is not one is skipped. */
export function parseLog(text: string): ComputerLogEntry[] {
  const out: ComputerLogEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as ComputerLogEntry
      if (typeof e.at === 'number' && typeof e.what === 'string' && typeof e.owner === 'string')
        out.push(e)
    } catch {
      // half a line from a crash mid-write
    }
  }
  return out
}

/** The most recent entries, newest first. Trims the file when it has grown long. */
export function recentComputerLog(limit = 100): ComputerLogEntry[] {
  try {
    const path = file()
    if (!existsSync(path)) return []
    const all = parseLog(readFileSync(path, 'utf8'))
    if (all.length > KEEP * 1.5)
      writeFileSync(
        path,
        all
          .slice(-KEEP)
          .map((e) => JSON.stringify(e))
          .join('\n') + '\n'
      )
    return all.slice(-limit).reverse()
  } catch {
    return []
  }
}
