import type { DanmakuPreferences } from '../src/core/danmakuProcessing'
import type { MessageAffixes } from '../src/core/messageComposition'
import type { DanmakuFeatures, DanmakuFeaturesSnapshot, AddFavoriteDanmaku, FavoriteDanmaku, FavoriteDanmakuPage } from './danmakuFeatures'
import type { DanmakuRate, MessageHistoryPage, MessageHistoryQuery } from '../server/danmaku/messageHistory'
import type { DeliveryEvidence } from '../server/danmaku/deliveryTracker'
import type { DouyuMessageInput, DouyuMessageOutcome } from '../server/douyu/types'
import type { DouyuMuteInput, DouyuModerationTarget, DouyuModerationOutcome, DouyuModerationPermission } from '../server/douyu/moderation'
import type { DouyuRoomInsights, DouyuFollowedRooms, DouyuBadgeAges, DouyuMonthlySpending, DouyuWatchTime } from '../server/douyu/insightsTypes'
import type { AppUpdateState } from './appUpdateService'
import { BACKEND_METHODS, type BackendMethods } from './backendContracts'

/** This context is constructed by trusted IPC, never read from renderer arguments. */
export interface FeatureCallContext { readonly senderId?: number }
export interface FeatureEvent { topic: string; data: unknown }
export interface DouyuLiveNotificationSettings { enabled: boolean; rooms?: string[]; accountId?: string }
export interface DouyuLiveNotificationState { enabled: boolean; rooms: string[]; followedAccountId: string | null }

export interface FeatureMethods extends BackendMethods {
  /** Implemented by IPC after checking this window's established room subscriptions. */
  activateDouyuRoom: { args: { room: string }; result: { room: string } }
  getDanmakuFeatures: { args: undefined; result: DanmakuFeaturesSnapshot }
  setDanmakuPreferences: { args: Partial<DanmakuPreferences>; result: DanmakuFeaturesSnapshot }
  setMessageAffixes: { args: Partial<MessageAffixes>; result: DanmakuFeaturesSnapshot }
  queryDanmakuHistory: { args: MessageHistoryQuery | undefined; result: MessageHistoryPage }
  queryDanmakuFavorites: { args: MessageHistoryQuery | undefined; result: FavoriteDanmakuPage }
  addDanmakuFavorite: { args: AddFavoriteDanmaku; result: FavoriteDanmaku }
  updateDanmakuFavorite: { args: { id: string; text: string }; result: FavoriteDanmaku }
  removeDanmakuFavorite: { args: { id: string }; result: { removed: true } }
  getDanmakuRate: { args: { room: string }; result: DanmakuRate }
  getDanmakuUserDetails: { args: { room: string; uid: string }; result: ReturnType<DanmakuFeatures['userDetails']> }
  openDanmakuHistory: { args: { uid: string }; result: { opened: true } }
  getDouyuDelivery: { args: { accountId: string; id: string }; result: DeliveryEvidence | null }
  sendComposedDouyuMessage: { args: DouyuMessageInput & { mode?: 'message' | 'repeat' }; result: DouyuMessageOutcome }
  previewDouyuMute: { args: DouyuModerationTarget; result: DouyuModerationPermission }
  muteDouyuUser: { args: DouyuMuteInput; result: DouyuModerationOutcome }
  getDouyuRoomInsights: { args: { room: string }; result: DouyuRoomInsights }
  refreshDouyuRoomInsights: { args: { room: string }; result: DouyuRoomInsights }
  getDouyuFollowedRooms: { args: { accountId: string }; result: DouyuFollowedRooms }
  getDouyuBadgeAges: { args: { accountId: string }; result: DouyuBadgeAges }
  getDouyuMonthlySpending: { args: { accountId: string }; result: DouyuMonthlySpending }
  getDouyuWatchTime: { args: { accountId: string; room: string }; result: DouyuWatchTime }
  reportDouyuPlayback: { args: { room: string; playing: boolean }; result: DouyuRoomInsights }
  setDouyuLiveNotifications: { args: DouyuLiveNotificationSettings; result: DouyuLiveNotificationState }
  checkAppUpdate: { args: undefined; result: AppUpdateState }
  getAppUpdateState: { args: undefined; result: AppUpdateState }
}

export type FeatureMethod = keyof FeatureMethods
/** One whitelist shared by preload and the feature dispatcher. */
export const FEATURE_METHODS = [
  ...BACKEND_METHODS,
  'activateDouyuRoom', 'getDanmakuFeatures', 'setDanmakuPreferences', 'setMessageAffixes',
  'queryDanmakuHistory', 'queryDanmakuFavorites', 'addDanmakuFavorite', 'updateDanmakuFavorite', 'removeDanmakuFavorite',
  'getDanmakuRate', 'getDanmakuUserDetails', 'openDanmakuHistory', 'getDouyuDelivery', 'sendComposedDouyuMessage',
  'previewDouyuMute', 'muteDouyuUser', 'getDouyuRoomInsights', 'refreshDouyuRoomInsights', 'getDouyuFollowedRooms',
  'getDouyuBadgeAges', 'getDouyuMonthlySpending', 'getDouyuWatchTime', 'reportDouyuPlayback', 'setDouyuLiveNotifications',
  'checkAppUpdate', 'getAppUpdateState',
] as const satisfies readonly FeatureMethod[]
