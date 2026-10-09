/**
 * Which stretches of a transcript are loop rounds that found nothing to do.
 *
 * A loop runs until it is stopped, and one that has run dry still checks in:
 * the prompt again, a line saying nothing is left, an hour later the same. Left
 * as they are those rounds bury the conversation under copies of one exchange,
 * so a run of them is drawn as a single line that can be opened.
 *
 * A round starts at one of the loop's own messages and runs to the next message
 * from the person or the loop. It is quiet when the agent said so (loop_idle).
 * The round still at the end of the transcript is never folded: it may be in
 * progress, and the latest word should be on screen.
 */
export interface RowFacts {
  /** A message sent as the user: typed, or one of the loop's rounds. */
  user: boolean
  /** One of the loop's own rounds. */
  round: boolean
  /** The agent called loop_idle here. */
  idle: boolean
}

export interface QuietRun {
  /** First row of the run, and one past its last. */
  from: number
  to: number
  rounds: number
}

export function quietRuns(rows: RowFacts[]): QuietRun[] {
  const runs: QuietRun[] = []
  let i = 0
  while (i < rows.length) {
    if (!rows[i].round) {
      i++
      continue
    }
    let end = i + 1
    let idle = false
    while (end < rows.length && !rows[end].user) {
      if (rows[end].idle) idle = true
      end++
    }
    // Reached the end of the transcript: the round may still be running.
    if (end >= rows.length || !idle) {
      i = end
      continue
    }
    const last = runs[runs.length - 1]
    if (last && last.to === i) {
      last.to = end
      last.rounds++
    } else runs.push({ from: i, to: end, rounds: 1 })
    i = end
  }
  return runs
}
