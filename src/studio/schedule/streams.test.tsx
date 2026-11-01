/** A stream plays once its channel is known; until then the sheet says why, and event icons sit beside the names. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { Cs2Match, Cs2Schedule, Cs2Stream } from '../../../electron/featureContracts'
import { ScheduleSheet } from './ScheduleSheet'

const NOW = Date.parse('2026-11-01T06:30:00Z')
const ICON = 'app://app/team-logo/gc?v=1'
const twitch = (over: Partial<Cs2Stream> = {}): Cs2Stream =>
  ({ platform: 'twitch', entry: 'Gamers_Club', channel: null, url: null, missing: 'finding', videoId: null, ...over })
function match(id: string, left: string, streams: Cs2Stream[]): Cs2Match {
  return { id, startsAt: NOW - 600_000, state: 'live', teams: [{ name: left, short: null, logo: null }, { name: 'Rival', short: null, logo: null }],
    score: [0, 1], bestOf: 3, streams,
    tournament: { name: 'Gamers Club Masters VII', stage: 'Playoffs', tier: 3, url: 'https://liquipedia.net/counterstrike/Gamers_Club/Masters/VII#Playoffs', logo: ICON } }
}
const schedule = (matches: Cs2Match[]): Cs2Schedule =>
  ({ fetchedAt: NOW, source: 'liquipedia', attribution: '赛程数据来自 Liquipedia (CC-BY-SA 3.0)', stale: false, matches })

let invoke: ReturnType<typeof vi.fn>
let reply: Cs2Schedule
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(NOW)
  invoke = vi.fn(async (method: string) => method === 'getCs2Schedule' ? { ok: true, value: reply } : { ok: true, value: [] })
  vi.stubGlobal('streamSyncer', {
    invoke, subscribeDanmaku: () => () => {}, subscribeFeatures: () => () => {},
  } as unknown as StreamSyncerBridge)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })

describe('schedule streams', () => {
  it('plays a matched channel and says why the others cannot play yet', async () => {
    reply = schedule([
      match('ok', 'Matched', [twitch({ channel: 'gamersclubcs', url: 'https://www.twitch.tv/gamersclubcs', missing: null }),
        { platform: 'youtube', entry: 'Gamers_Club', channel: null, url: null, missing: 'unmatched', videoId: null }]),
      match('finding', 'Finding', [twitch()]),
      match('failed', 'Failed', [twitch({ missing: 'failed' })]),
      match('unmatched', 'Unmatched', [twitch({ missing: 'unmatched' })]),
    ])
    const onWatch = vi.fn(), onClose = vi.fn()
    render(<ScheduleSheet onClose={onClose} onWatch={onWatch} />)
    await settle()

    const row = (name: string) => screen.getByRole('listitem', { name: `${name} 对 Rival` })
    // With one stream to play, its button leads and no note is shown; the one without a channel waits.
    expect(within(row('Matched')).getByRole('button', { name: /YouTube/ })).toBeDisabled()
    expect(within(row('Matched')).queryByText(/直播频道/)).toBeNull()
    fireEvent.click(within(row('Matched')).getByRole('button', { name: /Twitch.*gamersclubcs/ }))
    expect(onWatch).toHaveBeenCalledWith('https://www.twitch.tv/gamersclubcs')
    expect(onClose).toHaveBeenCalled()

    expect(within(row('Finding')).getByRole('button', { name: /Twitch.*Gamers_Club/ })).toBeDisabled()
    expect(within(row('Finding')).getByText('正在查找直播频道…')).toBeInTheDocument()
    expect(within(row('Failed')).getByText('暂时无法读取直播频道')).toBeInTheDocument()
    expect(within(row('Unmatched')).getByText('没找到这场比赛的直播频道，请手动粘贴直播链接')).toBeInTheDocument()

    // Titles are asked for the matched channel only.
    const asked = invoke.mock.calls.filter(([method]) => method === 'getStreamTitles').map(([, args]) => args)
    expect(asked).toEqual([{ streams: [{ platform: 'twitch', channel: 'gamersclubcs', videoId: null }] }])
  })

  it('shows the event icon beside its name in the list and over its matches, and leaves the box empty when it fails', async () => {
    reply = schedule([match('m', 'Team', [twitch()])])
    const { container } = render(<ScheduleSheet onClose={() => {}} onWatch={() => {}} />)
    await settle()
    const icons = () => [...container.querySelectorAll('img.sched-icon')] as HTMLImageElement[]
    expect(icons().map((icon) => icon.getAttribute('src'))).toEqual([ICON, ICON])
    expect(within(screen.getByRole('tab')).getByText('Gamers Club Masters VII')).toBeInTheDocument()
    fireEvent.error(icons()[0]!)
    expect(icons()).toHaveLength(1)
  })
})
