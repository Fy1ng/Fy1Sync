import type { StreamId } from './streamIdentity'
import type { ResolvedStream } from '../server/platforms'
import type { OpenStreamInput, StreamSessionView, StreamSessionsSnapshot } from './streamSessions'
import type { PipOptions, PipReport, PipState } from './pipManager'
import type { CaptureExport, GifOptions, GifRecording, MediaCapture } from './mediaCapture'
import type { AutomationSnapshot, CreateAutomation } from './automationManager'
import type { ActivityPreferences } from './activityPreferences'
import type { DouyuRenewalPlan } from '../server/douyu/renewalTypes'
import type { DouyuInventorySnapshot, DouyuGiftCatalog, DouyuInventoryGiftInput, DouyuPurchaseGiftInput, DouyuGiftPlan, DouyuGiftResult } from '../server/douyu/inventoryTypes'

export interface BackendMethods {
  openAppReleasePage: { args: undefined; result: { opened: true } }
  getStreamSessions: { args: undefined; result: StreamSessionsSnapshot }
  openStreamSession: { args: OpenStreamInput; result: StreamSessionView }
  closeStreamSession: { args: { id: StreamId }; result: StreamSessionsSnapshot }
  switchStreamSessionQuality: { args: { id: StreamId; quality: string }; result: StreamSessionView }
  restartStreamSession: { args: { id: StreamId }; result: StreamSessionView }
  getStreamPlayback: { args: { id: StreamId }; result: ResolvedStream | null }
  getEnhancedPip: { args: undefined; result: PipState }
  openEnhancedPip: { args: { id: StreamId; options?: Partial<PipOptions> }; result: PipState }
  setEnhancedPipOptions: { args: Partial<PipOptions>; result: PipState }
  closeEnhancedPip: { args: undefined; result: PipState }
  recoverEnhancedPip: { args: undefined; result: PipState }
  reportEnhancedPip: { args: PipReport; result: PipState }
  getCaptureState: { args: undefined; result: ReturnType<MediaCapture['state']> }
  setCaptureEnabled: { args: { enabled: boolean }; result: ReturnType<MediaCapture['state']> }
  savePlaybackScreenshot: { args: { png: string }; result: CaptureExport }
  beginGifRecording: { args: GifOptions; result: GifRecording }
  appendGifFrame: { args: { id: string; index: number; png: string }; result: GifRecording }
  finishGifRecording: { args: { id: string }; result: CaptureExport }
  cancelGifRecording: { args: { id: string }; result: { cancelled: boolean } }
  getDouyuAutomations: { args: undefined; result: AutomationSnapshot }
  createDouyuAutomation: { args: CreateAutomation; result: AutomationSnapshot }
  startDouyuAutomation: { args: { id: string }; result: AutomationSnapshot }
  pauseDouyuAutomation: { args: { id: string }; result: AutomationSnapshot }
  removeDouyuAutomation: { args: { id: string }; result: AutomationSnapshot }
  getDouyuActivityOptions: { args: undefined; result: ActivityPreferences }
  setDouyuActivityOptions: { args: ActivityPreferences; result: ActivityPreferences }
  previewDouyuRenewalEqual: { args: { accountId: string; rooms: string[] }; result: DouyuRenewalPlan }
  getDouyuInventory: { args: { accountId: string; room?: string; refresh?: boolean }; result: DouyuInventorySnapshot }
  getDouyuGiftCatalog: { args: { room: string }; result: DouyuGiftCatalog }
  previewDouyuInventoryGift: { args: { accountId: string; input: DouyuInventoryGiftInput }; result: DouyuGiftPlan }
  previewDouyuPurchaseGift: { args: { accountId: string; input: DouyuPurchaseGiftInput }; result: DouyuGiftPlan }
  executeDouyuGiftPlan: { args: { planId: string }; result: DouyuGiftResult }
  cancelDouyuGiftPlan: { args: { planId: string }; result: { cancelled: boolean } }
}
export const BACKEND_METHODS = [
  'openAppReleasePage',
  'getStreamSessions', 'openStreamSession', 'closeStreamSession', 'switchStreamSessionQuality', 'restartStreamSession', 'getStreamPlayback',
  'getEnhancedPip', 'openEnhancedPip', 'setEnhancedPipOptions', 'closeEnhancedPip', 'recoverEnhancedPip', 'reportEnhancedPip',
  'getCaptureState', 'setCaptureEnabled', 'savePlaybackScreenshot', 'beginGifRecording', 'appendGifFrame', 'finishGifRecording', 'cancelGifRecording',
  'getDouyuAutomations', 'createDouyuAutomation', 'startDouyuAutomation', 'pauseDouyuAutomation', 'removeDouyuAutomation',
  'getDouyuActivityOptions', 'setDouyuActivityOptions', 'previewDouyuRenewalEqual',
  'getDouyuInventory', 'getDouyuGiftCatalog', 'previewDouyuInventoryGift', 'previewDouyuPurchaseGift', 'executeDouyuGiftPlan', 'cancelDouyuGiftPlan',
] as const satisfies readonly (keyof BackendMethods)[]
