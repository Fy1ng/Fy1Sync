import type {
  ApiResult, HealthInfo, PresetRecord, PresetSummary, SavedPreset,
} from '../src/app/apiClient'
import type { RecognitionProfile } from '../src/core/profileSchema'
import type { ResolveResult } from '../server/platforms/types'
import type { SourceRole } from '../src/core/types'
import type { BufferState } from './bufferManager'
import type { LoginPlatform, LoginResult, LoginStatus } from './login'

export interface DesktopMethods {
  health: { args: undefined; result: HealthInfo }
  verifyAdmin: { args: { token: string }; result: { ok: true } }
  resolve: { args: { input: string; platform?: string; role?: SourceRole; quality?: string }; result: ResolveResult }
  switchQuality: { args: { role: SourceRole; quality: string }; result: ResolveResult }
  stopBuffer: { args: { role: SourceRole }; result: { ok: true } }
  login: { args: { platform: LoginPlatform }; result: LoginResult }
  loginStatus: { args: undefined; result: LoginStatus }
  logout: { args: { platform: LoginPlatform }; result: { ok: true } }
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
  subscribeBuffer?(listener: (state: BufferState) => void): () => void
}

declare global {
  interface Window { streamSyncer?: StreamSyncerBridge }
}
