import type {
  ApiResult, HealthInfo, PresetRecord, PresetSummary, SavedPreset,
} from '../src/app/apiClient'
import type { RecognitionProfile } from '../src/core/profileSchema'
import type { ResolveResult } from '../server/platforms/types'
import type { SourceRole } from '../src/core/types'
import type { BufferState } from './bufferManager'
import type { LoginPlatform, LoginResult, LoginStatus } from './login'
import type { DecoderMode, DecoderPreferenceState } from './decoderPreferences'
import type { ToolsStatus } from './toolsService'
import type { DouyuAccountsSnapshot, DouyuMessageInput, DouyuMessageOutcome, DouyuTasksSnapshot, DouyuTaskKind, DouyuTaskPolicy } from '../server/douyu/types'

export interface DesktopMethods {
  listDouyuAccounts: { args: undefined; result: DouyuAccountsSnapshot }
  addDouyuAccount: { args: { label: string }; result: DouyuAccountsSnapshot }
  renameDouyuAccount: { args: { id: string; label: string }; result: DouyuAccountsSnapshot }
  loginDouyuAccount: { args: { id: string }; result: DouyuAccountsSnapshot }
  loginDouyuYubaAccount: { args: { id: string }; result: DouyuAccountsSnapshot }
  sendDouyuMessage: { args: DouyuMessageInput; result: DouyuMessageOutcome }
  activateDouyuAccount: { args: { id: string }; result: DouyuAccountsSnapshot }
  logoutDouyuAccount: { args: { id: string }; result: DouyuAccountsSnapshot }
  removeDouyuAccount: { args: { id: string }; result: DouyuAccountsSnapshot }
  getDouyuTasks: { args: undefined; result: DouyuTasksSnapshot }
  createDouyuTask: { args: { accountId: string; roomInput: string; kind: DouyuTaskKind; policy: DouyuTaskPolicy; repeatMinutes: number | null }; result: DouyuTasksSnapshot }
  setDouyuTaskPolicy: { args: { id: string; policy: DouyuTaskPolicy }; result: DouyuTasksSnapshot }
  startDouyuTask: { args: { id: string }; result: DouyuTasksSnapshot }
  pauseDouyuTask: { args: { id: string }; result: DouyuTasksSnapshot }
  removeDouyuTask: { args: { id: string }; result: DouyuTasksSnapshot }
  retainDouyuTaskRoom: { args: { room: string; retain: boolean }; result: DouyuTasksSnapshot }
  closeDouyuTaskRoom: { args: { room: string }; result: DouyuTasksSnapshot }
  resolveDouyuRoom: { args: { input: string }; result: import('../server/platforms/douyuRoom').DouyuRoomResult }
  getToolsStatus: { args: undefined; result: ToolsStatus }
  updateYtdlp: { args: undefined; result: ToolsStatus }
  restoreYtdlp: { args: { target: 'previous' | 'bundled' }; result: ToolsStatus }
  health: { args: undefined; result: HealthInfo }
  getDecoderPreferences: { args: undefined; result: DecoderPreferenceState }
  setDecoderPreferences: { args: { mode: DecoderMode }; result: DecoderPreferenceState }
  verifyAdmin: { args: { token: string }; result: { ok: true } }
  resolve: { args: { input: string; platform?: string; role?: SourceRole; quality?: string; preferAdaptive?: boolean }; result: ResolveResult }
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
  subscribeDouyuTasks?(listener: (state: DouyuTasksSnapshot) => void): () => void
}

declare global {
  interface Window { streamSyncer?: StreamSyncerBridge }
}
