import { normalizeTournamentPath } from '../server/esports/tiers'
import { isActiveScheduleMatch } from '../server/esports/schedule'
import type { Cs2Match } from '../server/esports/types'

export function scheduleFocuses(matches: readonly Cs2Match[], previous: string | null, now: number): {
  waiting: string[]; active: string | null
} {
  const waiting = new Set<string>(), active = new Set<string>()
  for (const match of matches) {
    const path = normalizeTournamentPath(match.tournament.url)
    if (path === null) continue
    if (match.streams.some(stream => stream.missing === 'finding' || stream.missing === 'failed')) waiting.add(path)
    if (isActiveScheduleMatch(match, now)) active.add(path)
  }
  const events = [...active]
  const next = events.length ? events[(events.indexOf(previous ?? '') + 1) % events.length]! : null
  return { waiting: [...waiting], active: next }
}

export function focusArgument(path: string | null): { eventPath: string | null } {
  if (path === null) return { eventPath: null }
  const escaped = path.replaceAll('%', '%25').replaceAll(' ', '%20')
  return { eventPath: new URL(`/counterstrike/${escaped}`, 'https://liquipedia.net').pathname }
}
