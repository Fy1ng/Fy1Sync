import type { SessionSnapshot } from '../app/session'

export type OfficialHealth = 'empty' | 'error' | 'reconnecting' | 'stalled' | 'loading' | 'healthy'

export type OfficialFallbackPhase = 'watching' | 'waiting' | 'syncing' | 'synced' | 'recovered'

export interface OfficialFallbackState {
  phase: OfficialFallbackPhase
  /** Commentary preview visibility before switching, restored when returning to official. */
  restorePreviewHidden: boolean
  /** Streamer camera overlay enabled state before switching. */
  restoreCamera: boolean
  /** Prevents repeated automatic sync loops for the same recovery cycle. */
  syncAttempted: boolean
}

export interface PreviewStatusBadge {
  text: string
  tone: 'busy' | 'ready' | 'warn' | 'idle'
}

/** Classifies whether the official picture is healthy or currently impaired (loading/stalled/reconnecting/failed). */
export function assessOfficialHealth(snapshot: SessionSnapshot): OfficialHealth {
  const media = snapshot.media.official
  if (media.status === 'empty') return 'empty'
  const buffer = snapshot.buffers.official
  if (media.status === 'error' || buffer?.state === 'failed') return 'error'
  if (buffer?.state === 'reconnecting') return 'reconnecting'
  if (snapshot.playbackDiagnostics.official?.ongoing || media.buffering || buffer?.state === 'stalled') {
    return 'stalled'
  }
  if (media.status === 'loading' || buffer?.state === 'starting' || buffer?.state === 'buffering') {
    return 'loading'
  }
  return 'healthy'
}

export function isOfficialUnhealthy(health: OfficialHealth): boolean {
  return health === 'error' || health === 'reconnecting' || health === 'stalled' || health === 'loading'
}

export function cameraActivateHint(health: OfficialHealth): string {
  switch (health) {
    case 'error': return '画面加载失败 · 点击切到解说'
    case 'reconnecting': return '画面重连中 · 点击切到解说'
    case 'stalled': return '画面卡顿 · 点击切到解说'
    case 'loading': return '画面加载中 · 点击切到解说'
    default: return '点击切到解说画面'
  }
}

export function fallbackPreviewBadge(
  phase: OfficialFallbackPhase,
  health: OfficialHealth,
): PreviewStatusBadge | null {
  switch (health) {
    case 'error': return { text: '画面加载失败', tone: 'warn' }
    case 'reconnecting': return { text: '画面重连中…', tone: 'busy' }
    case 'stalled': return { text: '画面缓冲中…', tone: 'busy' }
    case 'loading': return { text: '画面加载中…', tone: 'busy' }
    case 'empty': return null
    case 'healthy': break
  }
  switch (phase) {
    case 'waiting': return { text: '已恢复，准备同步…', tone: 'busy' }
    case 'syncing': return { text: '已恢复，同步中…', tone: 'busy' }
    case 'synced': return { text: '已同步 · 点击切回', tone: 'ready' }
    case 'recovered': return { text: '已恢复 · 点击切回', tone: 'ready' }
    case 'watching': return { text: '点击切回画面', tone: 'idle' }
  }
}
