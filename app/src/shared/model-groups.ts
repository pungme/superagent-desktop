/**
 * Antigravity lists a model once per reasoning effort: "Gemini 4 Neon (Low)",
 * "(Medium)", "(High)", "(XHigh)" are four slugs. The picker shows one row per
 * model with its efforts beside it instead of the same name four times.
 *
 * Options that share a label and each carry an effort as their hint become one
 * group; everything else (Claude's and Codex's line-ups, Default) stays a row of
 * its own, in the order it came.
 */
export interface ModelOptionLike {
  value: string
  label: string
  hint: string
  older?: boolean
}

export type ModelRow<T extends ModelOptionLike> =
  | { kind: 'one'; option: T }
  | { kind: 'efforts'; label: string; efforts: { effort: string; option: T }[] }

const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function effortRank(hint: string): number {
  return EFFORT_ORDER.indexOf(hint.trim().toLowerCase())
}

/** True for a hint that names an effort ("High", "XHigh"). */
export function isEffort(hint: string): boolean {
  return effortRank(hint) >= 0
}

export function groupModelOptions<T extends ModelOptionLike>(options: T[]): ModelRow<T>[] {
  const byLabel = new Map<string, T[]>()
  for (const o of options) {
    if (!o.value || !isEffort(o.hint)) continue
    const list = byLabel.get(o.label) ?? []
    list.push(o)
    byLabel.set(o.label, list)
  }
  const rows: ModelRow<T>[] = []
  const placed = new Set<string>()
  for (const o of options) {
    const same = byLabel.get(o.label)
    if (!same || same.length < 2 || !same.includes(o)) {
      rows.push({ kind: 'one', option: o })
      continue
    }
    if (placed.has(o.label)) continue
    placed.add(o.label)
    rows.push({
      kind: 'efforts',
      label: o.label,
      efforts: [...same]
        .sort((a, b) => effortRank(a.hint) - effortRank(b.hint))
        .map((option) => ({ effort: option.hint, option }))
    })
  }
  return rows
}

/** What the model pill says: the name, and the effort when there is a choice of them. */
export function modelPillLabel<T extends ModelOptionLike>(
  options: T[],
  value: string
): string | undefined {
  const o = options.find((m) => m.value === value)
  if (!o) return undefined
  const siblings = options.filter((m) => m.label === o.label && m.value && isEffort(m.hint))
  return siblings.length > 1 && isEffort(o.hint) ? `${o.label} · ${o.hint}` : o.label
}
