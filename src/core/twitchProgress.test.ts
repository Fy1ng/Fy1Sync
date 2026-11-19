import { describe, expect, it, vi } from 'vitest'
import {
  createTwitchProgressSnapshot,
  getTwitchProgressOfficialLinks,
  TWITCH_PROGRESS_EVIDENCE,
  TWITCH_PROGRESS_EVIDENCE_CHECKED_ON,
  TWITCH_PROGRESS_OFFICIAL_URLS,
  type TwitchProgressContext,
  type TwitchProgressSnapshot,
} from './twitchProgress'

const isolatedContext: TwitchProgressContext = {
  accountId: 'isolated-account-a',
  channelId: '10001',
  channelLogin: 'fixture_channel_a',
  streamId: '20001',
  viewerAuthorization: 'authorized',
}

function metrics(snapshot: TwitchProgressSnapshot) {
  return [snapshot.watchMinutes, snapshot.channelPoints, snapshot.watchStreak, snapshot.dropsProgress, snapshot.dropEntitlements]
}

describe('Twitch read-only progress snapshot', () => {
  it('keeps all five personal metrics unknown rather than zero or an empty inventory', () => {
    const snapshot = createTwitchProgressSnapshot(isolatedContext)
    expect(snapshot.platform).toBe('twitch')
    expect(snapshot.accountId).toBe('isolated-account-a')
    expect(snapshot.channelId).toBe('10001')
    expect(snapshot.streamId).toBe('20001')
    expect(metrics(snapshot).map(metric => metric.unit)).toEqual([
      'minutes', 'points', 'broadcasts', 'campaign-reward-progress', 'entitlements',
    ])
    for (const metric of metrics(snapshot)) {
      expect(metric.status).toBe('unverified')
      expect(metric.value).toBeNull()
      expect(metric.checkedAt).toBeNull()
      expect(metric.detail.length).toBeGreaterThan(0)
    }
    expect(snapshot.watchMinutes.reason).toBe('official-readback-unavailable')
    expect(snapshot.channelPoints.reason).toBe('official-readback-unavailable')
    expect(snapshot.watchStreak.reason).toBe('official-readback-unavailable')
    expect(snapshot.dropsProgress.reason).toBe('official-readback-unavailable')
    expect(snapshot.dropEntitlements.reason).toBe('publisher-authorization-required')
  })

  it('does not treat an account slot or playback context as viewer OAuth', () => {
    const snapshot = createTwitchProgressSnapshot({
      accountId: 'isolated-playback-account', channelId: '10001', channelLogin: 'fixture_channel_a',
    })
    expect(snapshot.viewerAuthorization).toBe('missing')
    expect(metrics(snapshot).every(metric => metric.reason === 'viewer-authorization-missing')).toBe(true)
    expect(createTwitchProgressSnapshot().accountId).toBeNull()
  })

  it('marks expired authorization without inheriting official values', () => {
    const snapshot = createTwitchProgressSnapshot({ ...isolatedContext, viewerAuthorization: 'expired' })
    expect(metrics(snapshot).every(metric => metric.reason === 'viewer-authorization-expired' && metric.value === null)).toBe(true)
  })

  it('requires a bound account even when the caller reports authorized OAuth', () => {
    const snapshot = createTwitchProgressSnapshot({ ...isolatedContext, accountId: ' ' })
    expect(snapshot.accountId).toBeNull()
    expect(metrics(snapshot).every(metric => metric.reason === 'account-unresolved')).toBe(true)
  })

  it.each([null, 'fixture_channel_a'])('does not replace a formal channel id with the channel login or stream id (%s)', channelId => {
    const snapshot = createTwitchProgressSnapshot({ ...isolatedContext, channelId })
    expect(snapshot.channelId).toBeNull()
    expect(snapshot.streamId).toBeNull()
    expect(snapshot.watchMinutes.reason).toBe('channel-unresolved')
    expect(snapshot.channelPoints.reason).toBe('channel-unresolved')
    expect(snapshot.watchStreak.reason).toBe('channel-unresolved')
    expect(snapshot.dropsProgress.reason).toBe('official-readback-unavailable')
    expect(snapshot.officialLinks.inventory).toBe(TWITCH_PROGRESS_OFFICIAL_URLS.inventory)
  })

  it('separates channel switches, concurrent channels and account switches without distributing progress', () => {
    const first = createTwitchProgressSnapshot(isolatedContext)
    const second = createTwitchProgressSnapshot({
      ...isolatedContext, channelId: '10002', channelLogin: 'fixture_channel_b', streamId: '20002',
    })
    const otherAccount = createTwitchProgressSnapshot({ ...isolatedContext, accountId: 'isolated-account-b' })
    expect(first.channelId).toBe('10001')
    expect(second.channelId).toBe('10002')
    expect(otherAccount.accountId).toBe('isolated-account-b')
    expect(first.officialLinks.channel).not.toBe(second.officialLinks.channel)
    for (const snapshot of [first, second, otherAccount]) {
      expect(metrics(snapshot).every(metric => metric.value === null)).toBe(true)
    }
  })

  it('does not turn elapsed time, reward progress or HLS observations into readback', () => {
    const withLocalData = {
      ...isolatedContext,
      playbackMinutes: 90,
      decodedBytes: 1_000_000,
      channelPointsBalance: 180,
      watchStreakCount: 5,
      campaignId: 'isolated-campaign',
      rewardId: 'isolated-reward',
      campaignEndsAt: '2026-11-18T00:00:00Z',
      progressPercent: 80,
      claimed: true,
      entitlements: [],
    }
    const before = createTwitchProgressSnapshot(withLocalData)
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-11-30T00:00:00Z'))
      expect(createTwitchProgressSnapshot(withLocalData)).toEqual(before)
      expect(metrics(before).every(metric => metric.value === null && metric.checkedAt === null)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('creates independent snapshots without mutating or retaining caller context', () => {
    const context = { ...isolatedContext }
    const first = createTwitchProgressSnapshot(context)
    context.accountId = 'isolated-account-b'
    context.channelId = '10002'
    const second = createTwitchProgressSnapshot(context)
    expect(first.accountId).toBe('isolated-account-a')
    expect(first.channelId).toBe('10001')
    expect(first.watchMinutes).not.toBe(second.watchMinutes)
    expect(first.officialLinks).not.toBe(second.officialLinks)
    expect(second.accountId).toBe('isolated-account-b')
  })
})

describe('Twitch official progress reference links', () => {
  it('uses fixed official inventory and campaign URLs plus a canonical channel login', () => {
    const links = getTwitchProgressOfficialLinks(' Fixture_Channel_A ')
    expect(links.channel).toBe('https://www.twitch.tv/fixture_channel_a')
    expect(links.inventory).toBe('https://www.twitch.tv/drops/inventory')
    expect(links.campaigns).toBe('https://www.twitch.tv/drops/campaigns')
    expect(links.watchStreaks).toBe('https://help.twitch.tv/s/article/recover-watch-streaks?language=en_US')
  })

  it.each([
    '', 'ab', 'a'.repeat(26), 'https://www.twitch.tv/fixture_channel_a',
    'evil.example/fixture', 'fixture?redirect=evil.example', '../settings',
    'fixture/videos', 'fixture#fragment', 'settings', 'DROPS', 'videos', 'inventory',
  ])('does not build a channel link from an invalid or reserved input: %s', input => {
    const links = getTwitchProgressOfficialLinks(input)
    expect(links.channel).toBeNull()
    expect(links.inventory).toBe(TWITCH_PROGRESS_OFFICIAL_URLS.inventory)
    expect(links.campaigns).toBe(TWITCH_PROGRESS_OFFICIAL_URLS.campaigns)
    expect(createTwitchProgressSnapshot({ channelLogin: input }).channelLogin).toBeNull()
  })

  it('keeps the documentation check date separate from any personal readback time', () => {
    expect(TWITCH_PROGRESS_EVIDENCE_CHECKED_ON).toBe('2026-11-19')
    expect(createTwitchProgressSnapshot().evidenceCheckedOn).toBe(TWITCH_PROGRESS_EVIDENCE_CHECKED_ON)
    for (const evidence of TWITCH_PROGRESS_EVIDENCE) {
      for (const url of evidence.urls) {
        expect(['help.twitch.tv', 'dev.twitch.tv']).toContain(new URL(url).hostname)
      }
    }
    expect(TWITCH_PROGRESS_EVIDENCE.find(evidence => evidence.id === 'drops-expiration')?.status).toBe('conflicting-guidance')
    expect(TWITCH_PROGRESS_EVIDENCE.find(evidence => evidence.id === 'drops-embedded-viewing')?.status).toBe('not-established')
  })
})
