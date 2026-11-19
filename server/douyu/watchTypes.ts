/** Public watch-state DTOs. Credentials and stream URLs never cross this boundary. */
export type DouyuWatchPhase = 'idle' | 'login-required' | 'paused' | 'connecting' | 'reporting' | 'yielding' | 'unverified' | 'verified' | 'failed'

export interface DouyuWatchRead {
  at: number
  status: 'available' | 'missing' | 'failed'
}

export const douyuWatchDay = (at: number): number => Math.floor((at + 8 * 60 * 60_000) / 86_400_000)

export interface DouyuWatchState {
  accountId: string | null
  room: string | null
  phase: DouyuWatchPhase
  reason: string | null
  officialSeconds: number | null
  baselineSeconds: number | null
  verifiedIncrease: number
  checkedAt: number | null
  dailyRead: DouyuWatchRead | null
  lastHeartbeatAt: number | null
  cumulativeSeconds: number | null
  cumulativeBaselineSeconds: number | null
  cumulativeIncrease: number
  cumulativeCheckedAt: number | null
  cumulativeRead: DouyuWatchRead | null
  badgeOwned: boolean | null
  badgeLevel: number | null
}

/** Samples are observations, never caller-supplied elapsed time or room identities. */
export interface DouyuWatchPlaybackReport {
  role: 'official' | 'commentary'
  playing: boolean
  currentTime: number
  decodedBytes: number | null
  presentedFrames: number | null
}
