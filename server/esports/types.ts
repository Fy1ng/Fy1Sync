export interface Cs2Team { name: string; short: string | null; logo: string | null }
export interface Cs2Stream {
  platform: 'youtube' | 'twitch'
  channel: string
  url: string
  videoId: string | null
}
export interface Cs2Match {
  id: string
  startsAt: number
  state: 'live' | 'upcoming' | 'finished'
  teams: [Cs2Team, Cs2Team]
  score: [number, number] | null
  bestOf: number | null
  tournament: { name: string; stage: string | null; tier: 1 | 2 | 3 | 4 | -1 | null; url: string }
  streams: Cs2Stream[]
}
export interface Cs2Schedule {
  fetchedAt: number
  source: 'liquipedia'
  attribution: string
  stale: boolean
  error?: string
  matches: Cs2Match[]
}
export type StreamTitleInput = Pick<Cs2Stream, 'platform' | 'channel' | 'videoId'>
export interface StreamTitle extends StreamTitleInput {
  title: string | null
  stage: string | null
  live: boolean | null
}
