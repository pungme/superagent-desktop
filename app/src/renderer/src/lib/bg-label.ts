/**
 * Split a shell line on `;` and `&&` — but only the ones the shell itself
 * would split on. A separator inside quotes belongs to the quoted string:
 * `ssh host "for i in …; do …; done" > log` is ONE command, and splitting it
 * naively named the pill after its last fragment, `done"`.
 */
function splitCommands(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < line.length) {
        cur += c + line[++i]
        continue
      }
      if (c === quote) quote = null
      cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    if (c === ';' || (c === '&' && line[i + 1] === '&')) {
      out.push(cur)
      cur = ''
      if (c === '&') i++
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/**
 * A short, meaningful name for a backgrounded command. The real command is
 * often buried behind env setup — `export PATH=…; SP_TOKEN=$(…); node deadline.mjs &`
 * — so skip leading assignments, `export`, `nohup`, `sudo` and the like, and
 * name it by the actual program (and its script, if it has one).
 */
export function bgLabel(command: string): string {
  const bare = command.replace(/&\s*(disown)?\s*;?\s*$/, '').trim()
  // The agent backgrounds `sleep N; echo done` as a wait/poll timer while other
  // work runs. Naming it "sleep" reads like the app dozed off (and taking the
  // last `;` segment would call it "echo"); say what it actually is.
  const wait = bare.match(/^sleep\s+(\d+)\b/)
  if (wait) {
    const s = Number(wait[1])
    return s >= 60 ? `wait ${Math.round(s / 60)}m` : `wait ${s}s`
  }
  // Last segment of a ; / && chain is usually the real work.
  const seg = splitCommands(bare).pop()
  const tokens = (seg || command).split(/\s+/).filter(Boolean)
  const skip = /^(export|nohup|sudo|env|time|VAR=|[A-Z_][A-Z0-9_]*=)/
  let i = 0
  while (i < tokens.length && (skip.test(tokens[i]) || tokens[i].includes('='))) i++
  const prog = (tokens[i] || tokens[0] || 'job').split('/').pop() || 'job'
  // For an interpreter, the script name is what the user recognises.
  if (/^(node|python3?|ruby|bash|sh|deno|bun|npx)$/.test(prog)) {
    // An inline script (`bash -c '…'`, `node -e '…'`) has no name to show.
    if (tokens.slice(i + 1).some((t) => t === '-c' || t === '-e')) return prog
    const arg = tokens.slice(i + 1).find((t) => !t.startsWith('-'))
    if (arg) return arg.split('/').pop() || prog
  }
  // A remote job: which machine it's on is the part you'd recognise.
  if (prog === 'ssh') {
    // Flags that take a value (`-i key`, `-p 2222`) must not read as the host.
    const takesValue = /^-[bcDEeFIiJLlmOoPpQRSWw]$/
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j]
      if (takesValue.test(t)) j++
      else if (!t.startsWith('-')) return `ssh ${t.replace(/^[^@]*@/, '')}`
    }
  }
  return prog
}
