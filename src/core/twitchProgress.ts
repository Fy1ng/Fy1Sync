export const TWITCH_PROGRESS_EVIDENCE_CHECKED_ON = '2026-11-19'

export const TWITCH_PROGRESS_OFFICIAL_URLS = {
  inventory: 'https://www.twitch.tv/drops/inventory',
  campaigns: 'https://www.twitch.tv/drops/campaigns',
  channelPointsFaq: 'https://help.twitch.tv/s/article/channel-points-faq?language=en_US',
  channelPointsGuide: 'https://help.twitch.tv/s/article/viewer-channel-point-guide?language=en_US',
  watchStreaks: 'https://help.twitch.tv/s/article/recover-watch-streaks?language=en_US',
  dropsGuide: 'https://help.twitch.tv/s/article/mission-based-drops?language=en_US',
  dropsTroubleshooting: 'https://help.twitch.tv/s/article/drops-troubleshooting?language=en_US',
  dropsTechnicalGuide: 'https://dev.twitch.tv/docs/drops/technical-guide/',
  dropsEntitlements: 'https://dev.twitch.tv/docs/api/reference/entitlements#get-drops-entitlements',
  channelPointRedemptions: 'https://dev.twitch.tv/docs/api/reference/channel-points/#get-custom-reward-redemption',
} as const

export const TWITCH_PROGRESS_EVIDENCE = [
  {
    id: 'channel-points',
    status: 'verified-rule',
    urls: [TWITCH_PROGRESS_OFFICIAL_URLS.channelPointsFaq, TWITCH_PROGRESS_OFFICIAL_URLS.channelPointsGuide],
    detail: '积分余额在频道聊天底部查看, 仅本人可见且逐频道独立. 站外嵌入不赚积分, 官方限定 twitch.tv 频道页或 Twitch app. 积分不自然过期, 频道被删除则丢失. 积分还来自关注, Raid, 奖励和订阅倍数, 不能反推逐房分钟. 本次资料未明确普通双频道同时赚积分的上限, Squad Stream 仅主频道赚积分的规则不能外推.',
  },
  {
    id: 'watch-streak',
    status: 'verified-rule',
    urls: [TWITCH_PROGRESS_OFFICIAL_URLS.watchStreaks, TWITCH_PROGRESS_OFFICIAL_URLS.channelPointsGuide],
    detail: 'Watch Streak 在聊天图标和里程碑通知中对照, 统计同频道连续直播场次, 不等于观时或 Drops 多日任务. 登录且频道启用积分, 每场直播至少 10 分钟, 两场之间至少间隔 30 分钟. 不同频道可各有连续记录. 原有 3 场以上连续记录漏看后可在首个漏看场次结束起 24 小时内恢复, 恢复保留次数而不增加次数. 实际恢复资格和成功必须由官方界面确认, 本适配不发起恢复.',
  },
  {
    id: 'drops-progress',
    status: 'verified-rule',
    urls: [TWITCH_PROGRESS_OFFICIAL_URLS.dropsGuide, TWITCH_PROGRESS_OFFICIAL_URLS.dropsTroubleshooting],
    detail: '当前频道聊天的 Drops 图标或顶部横幅打开 Drops & More, 全部活动进度在 Drops Inventory, 资格和活动时段在 All Campaigns. 普通观看型 Drops 要求合资格直播, VOD, 重播和剪辑不算. 同时仅一个频道推进, 观看两个频道不能加速, 官方帮助也限定一次一个活动. 同活动可换合资格频道继续或在活动有效期内暂停再继续. 活动结束不能继续未完成进度. 活动进度不能分摊成个人逐房累计分钟.',
  },
  {
    id: 'drops-embedded-viewing',
    status: 'not-established',
    urls: [TWITCH_PROGRESS_OFFICIAL_URLS.channelPointsFaq, TWITCH_PROGRESS_OFFICIAL_URLS.dropsGuide],
    detail: '已核验的积分 FAQ 明确站外嵌入不赚积分. 已核验的 Drops 资料支持浏览器及 Android/iOS app, 未明确站外嵌入或 Fy1Sync HLS 播放能否推进 Drops. 不外推积分规则, 不从 HLS, 本地播放时长或聊天事件推定 Drops 入账.',
  },
  {
    id: 'drops-expiration',
    status: 'conflicting-guidance',
    urls: [TWITCH_PROGRESS_OFFICIAL_URLS.dropsGuide, TWITCH_PROGRESS_OFFICIAL_URLS.dropsTechnicalGuide],
    detail: '官方观众指南正文写活动结束后最多 7 天可领取, 同页 FAQ 又写未领权益随活动结束过期; 开发者技术 FAQ 写可在结束后 14 天内关联并领取. 领取期限, 关联履约期限及兑换期限不能混为一个倒计时. 本适配不硬编码个人领取或兑换截止时间, 以具体活动和 Inventory 的官方状态为准. 多日 Drops 可能采用起看时刻开启的滚动 24 小时窗口, 未完成窗口的分钟不结转, 已完成天数保留, 不按本地自然日重置.',
  },
  {
    id: 'publisher-entitlements',
    status: 'verified-api-boundary',
    urls: [TWITCH_PROGRESS_OFFICIAL_URLS.dropsEntitlements, TWITCH_PROGRESS_OFFICIAL_URLS.dropsTechnicalGuide],
    detail: 'Get Drops Entitlements 接受 app 或 user token, 两者的 Client ID 所有人都必须属于拥有游戏的开发者组织. app token 可读取该组织权益, user token 还限定令牌本人. 返回 id, benefit_id, timestamp, user_id, game_id, fulfillment_status, last_updated 和分页; 不返回未完成进度, 逐房分钟, 来源频道或活动 ID. CLAIMED 表示已在 Twitch 领取, FULFILLED 表示发行方报告已发放, 二者分列. 普通观众 OAuth 不提供全游戏库存读取资格, 单页空列表也不能证明全量没有权益. 本批未提供发行方凭据且不发起权益写入.',
  },
  {
    id: 'channel-point-redemptions',
    status: 'verified-api-boundary',
    urls: [TWITCH_PROGRESS_OFFICIAL_URLS.channelPointRedemptions],
    detail: '兑换查询要求主播 user token 的 channel:read:redemptions 或 channel:manage:redemptions, broadcaster_id 必须是令牌本人, 且仅创建奖励的应用可查该奖励兑换. 返回奖励成本和兑换状态, 不返回观众积分余额, 个人逐房分钟或 Watch Streak. 主播和房管能力不能作为这些个人指标的读回.',
  },
] as const

export type TwitchViewerAuthorization = 'missing' | 'authorized' | 'expired'

export type TwitchProgressUnknownReason =
  | 'viewer-authorization-missing'
  | 'viewer-authorization-expired'
  | 'account-unresolved'
  | 'channel-unresolved'
  | 'official-readback-unavailable'
  | 'publisher-authorization-required'

export interface TwitchProgressContext {
  accountId?: string | null
  channelId?: string | null
  channelLogin?: string | null
  streamId?: string | null
  viewerAuthorization?: TwitchViewerAuthorization
}

export interface TwitchUnknownProgressMetric<Unit extends string> {
  readonly status: 'unverified'
  readonly value: null
  readonly unit: Unit
  readonly checkedAt: null
  readonly reason: TwitchProgressUnknownReason
  readonly detail: string
  readonly officialUrl: string | null
}

export interface TwitchProgressOfficialLinks {
  readonly channel: string | null
  readonly inventory: typeof TWITCH_PROGRESS_OFFICIAL_URLS.inventory
  readonly campaigns: typeof TWITCH_PROGRESS_OFFICIAL_URLS.campaigns
  readonly channelPointsGuide: typeof TWITCH_PROGRESS_OFFICIAL_URLS.channelPointsGuide
  readonly watchStreaks: typeof TWITCH_PROGRESS_OFFICIAL_URLS.watchStreaks
  readonly dropsGuide: typeof TWITCH_PROGRESS_OFFICIAL_URLS.dropsGuide
}

export interface TwitchProgressSnapshot {
  readonly platform: 'twitch'
  readonly accountId: string | null
  readonly channelId: string | null
  readonly channelLogin: string | null
  readonly streamId: string | null
  readonly viewerAuthorization: TwitchViewerAuthorization
  readonly evidenceCheckedOn: typeof TWITCH_PROGRESS_EVIDENCE_CHECKED_ON
  readonly officialLinks: TwitchProgressOfficialLinks
  readonly watchMinutes: TwitchUnknownProgressMetric<'minutes'>
  readonly channelPoints: TwitchUnknownProgressMetric<'points'>
  readonly watchStreak: TwitchUnknownProgressMetric<'broadcasts'>
  readonly dropsProgress: TwitchUnknownProgressMetric<'campaign-reward-progress'>
  readonly dropEntitlements: TwitchUnknownProgressMetric<'entitlements'>
}

const RESERVED_CHANNEL_PATHS = new Set([
  'directory', 'downloads', 'drops', 'inventory', 'moderator', 'popout', 'settings',
  'store', 'subscriptions', 'videos', 'wallet',
])

function nonEmptyString(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function officialId(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^\d{1,30}$/.test(value) ? value : null
}

function normalizedChannelLogin(value: string | null | undefined): string | null {
  const login = nonEmptyString(value)?.toLowerCase()
  return login && /^[a-z0-9_]{3,25}$/.test(login) && !RESERVED_CHANNEL_PATHS.has(login) ? login : null
}

export function getTwitchProgressOfficialLinks(channelLogin?: string | null): TwitchProgressOfficialLinks {
  const login = normalizedChannelLogin(channelLogin)
  return {
    channel: login ? `https://www.twitch.tv/${login}` : null,
    inventory: TWITCH_PROGRESS_OFFICIAL_URLS.inventory,
    campaigns: TWITCH_PROGRESS_OFFICIAL_URLS.campaigns,
    channelPointsGuide: TWITCH_PROGRESS_OFFICIAL_URLS.channelPointsGuide,
    watchStreaks: TWITCH_PROGRESS_OFFICIAL_URLS.watchStreaks,
    dropsGuide: TWITCH_PROGRESS_OFFICIAL_URLS.dropsGuide,
  }
}

export function createTwitchProgressSnapshot(context: TwitchProgressContext = {}): TwitchProgressSnapshot {
  const accountId = nonEmptyString(context.accountId)
  const channelId = officialId(context.channelId)
  const channelLogin = normalizedChannelLogin(context.channelLogin)
  const viewerAuthorization = context.viewerAuthorization === 'authorized' || context.viewerAuthorization === 'expired'
    ? context.viewerAuthorization : 'missing'
  const officialLinks = getTwitchProgressOfficialLinks(channelLogin)
  const accountReason: TwitchProgressUnknownReason | null = viewerAuthorization === 'expired'
    ? 'viewer-authorization-expired'
    : viewerAuthorization !== 'authorized' ? 'viewer-authorization-missing'
      : !accountId ? 'account-unresolved' : null
  const channelReason = accountReason ?? (!channelId ? 'channel-unresolved' : 'official-readback-unavailable')
  const unknown = <Unit extends string>(
    unit: Unit,
    reason: TwitchProgressUnknownReason,
    detail: string,
    officialUrl: string | null,
  ): TwitchUnknownProgressMetric<Unit> => ({ status: 'unverified', value: null, unit, checkedAt: null, reason, detail, officialUrl })

  return {
    platform: 'twitch',
    accountId,
    channelId,
    channelLogin,
    streamId: channelId ? officialId(context.streamId) : null,
    viewerAuthorization,
    evidenceCheckedOn: TWITCH_PROGRESS_EVIDENCE_CHECKED_ON,
    officialLinks,
    watchMinutes: unknown('minutes', channelReason,
      '个人逐频道累计分钟未有官方读回. 频道页仅核对频道和直播, 积分, 活动进度及本地播放时长均不能换算为此值.', officialLinks.channel),
    channelPoints: unknown('points', channelReason,
      '个人频道积分余额未读回. 对照频道聊天底部本人余额; 站外嵌入不赚积分. 奖励成本或兑换事件不是余额.', officialLinks.channel ?? officialLinks.channelPointsGuide),
    watchStreak: unknown('broadcasts', channelReason,
      '连续观看记录未读回. 对照频道聊天的 Watch Streak 图标或通知, 不从分钟, 本地日期或 Drops 多日任务计算.', officialLinks.channel ?? officialLinks.watchStreaks),
    dropsProgress: unknown('campaign-reward-progress', accountReason ?? 'official-readback-unavailable',
      '活动及奖励进度未读回. 对照 Drops & More 或 Inventory, 资格及时段看 All Campaigns. 同时仅一个频道推进, 同活动可换合资格频道继续; 站外 HLS 入账及具体过期时间未验证.', officialLinks.inventory),
    dropEntitlements: unknown('entitlements', accountReason ?? 'publisher-authorization-required',
      '已发权益未读回, 未提供游戏发行方组织应用授权. Inventory 已领取与发行方 FULFILLED 分开核对; 普通观众 OAuth, 已领取或空列表不证明游戏到账或没有权益.', officialLinks.inventory),
  }
}
