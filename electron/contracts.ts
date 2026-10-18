import type {
  ApiResult, HealthInfo, PresetRecord, PresetSummary, SavedPreset,
} from '../src/app/apiClient'
import type { RecognitionProfile } from '../src/core/profileSchema'
import type { ResolveResult } from '../server/platforms/types'

export interface DesktopMethods {
  health: { args: undefined; result: HealthInfo }
  verifyAdmin: { args: { token: string }; result: { ok: true } }
  resolve: { args: { input: string; platform?: string }; result: ResolveResult }
  listPresets: { args: undefined; result: { presets: PresetSummary[] } }
  getPreset: { args: { id: string }; result: PresetRecord }
  savePreset: { args: { id: string; profile: RecognitionProfile; token?: string; etag?: string }; result: SavedPreset }
  deletePreset: { args: { id: string; token?: string }; result: { ok: true } }
}

export type DesktopMethod = keyof DesktopMethods
export interface DanmakuEvent { event: string; data: unknown }
export interface StreamSyncerBridge {
  invoke<K extends DesktopMethod>(method: K, args: DesktopMethods[K]['args']): Promise<ApiResult<DesktopMethods[K]['result']>>
  subscribeDanmaku(room: string, listener: (event: DanmakuEvent) => void): () => void
}

declare global {
  interface Window { streamSyncer?: StreamSyncerBridge }
}
