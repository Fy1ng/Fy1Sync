export interface Cs2Team { name: string; short: string | null; logo: string | null }
export interface Cs2Stream {
  platform: 'youtube' | 'twitch'
  /** Liquipedia's stream registry entry (`Special:Stream/<platform>/<entry>`): a name, not a channel. */
  entry: string
  /** The channel the entry was matched to among the event page's links, once known. */
  channel: string | null
  /** What to load: the video the schedule names, or the matched channel's live page; null until known. */
  url: string | null
  /** Why `url` is still null: the event page is being read, lists no matching channel, or could not be read. */
  missing: 'finding' | 'unmatched' | 'failed' | null
  videoId: string | null
}
export interface Cs2Match {
  id: string
  startsAt: number
  state: 'live' | 'upcoming' | 'finished'
  teams: [Cs2Team, Cs2Team]
  score: [number, number] | null
  bestOf: number | null
  /** `logo` is the event's icon beside its name on the schedule, as main's cached copy. */
  tournament: { name: string; stage: string | null; tier: 1 | 2 | 3 | 4 | -1 | null; url: string; logo: string | null }
  streams: Cs2Stream[]
}
export interface Cs2Schedule {
  fetchedAt: number
  source: 'liquipedia'
  attribution: string
  stale: boolean
  error?: string
  /** Set when a refresh was refused for Liquipedia's 30-second parse limit: when one may run again. */
  refreshAt?: number
  matches: Cs2Match[]
}
/**
 * One stream whose title to read: a YouTube video by its id, a Twitch channel by its login.
 * For YouTube `channel` only names the stream (the channel when known, else the entry).
 */
export interface StreamTitleInput { platform: Cs2Stream['platform']; channel: string; videoId: string | null }
export interface StreamTitle extends StreamTitleInput {
  title: string | null
  stage: string | null
  live: boolean | null
}
