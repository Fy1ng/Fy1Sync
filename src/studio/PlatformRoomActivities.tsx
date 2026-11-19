import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { apiClient } from '../app/apiClient'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { SOURCE_ROLES } from '../core/types'
import { matchBilibiliLotteryMessage, type BilibiliLotterySnapshot } from '../core/bilibiliLottery'
import { HuyaOnTvReminders } from '../core/huyaOnTv'
import { BilibiliLotteryCards } from './BilibiliLotteryCard'
import { DouyinLotteryCard } from './douyinLottery/DouyinLotteryCard'
import { useDouyinLottery } from './douyinLottery/useDouyinLottery'
import { HuyaOnTvCard } from './HuyaOnTvCard'

export function usePlatformRoomActivities() {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const { room, connected, connectionRevision, huyaOnTv } = snapshot.danmaku
  const [huyaReminders, setHuyaReminders] = useState(false)
  const [huyaReminderGuard] = useState(() => new HuyaOnTvReminders())
  const biliSnapshots = useRef(new Map<string, BilibiliLotterySnapshot>())
  const sources = SOURCE_ROLES.flatMap(slot => {
    const media = snapshot.media[slot]
    const descriptor = media.descriptor
    return descriptor?.platform === 'bilibili' && descriptor.sourceRoom && media.status === 'ready'
      ? [{ slot, input: descriptor.sourceRoom, platform: 'bilibili', active: true, reconnectKey: String(session.sourceRevision(slot)) }] : []
  })
  const sourceKey = sources.map(source => `${source.slot}:${source.input}:${source.reconnectKey}`).join('|')
  const recordSnapshot = useCallback((value: BilibiliLotterySnapshot) => {
    if (!value?.room) return
    biliSnapshots.current.set(value.room, value)
  }, [])
  const notify = useCallback((message: string) => { session.notice('info', message) }, [session])
  const douyin = useDouyinLottery(room, connected ? connectionRevision ?? 0 : null, {
    read: async (target, signal) => {
      const result = await apiClient.feature('getDouyinLottery', { room: target })
      return !signal.aborted && result.ok ? result.value : null
    },
    openOfficial: async input => {
      const result = await apiClient.feature('openDouyinLotteryRoom', input)
      return result.ok && result.value.opened ? { ok: true } : { ok: false, message: '活动已结束或房间已切换' }
    },
    notify,
  })
  useLayoutEffect(() => { biliSnapshots.current.clear() }, [sourceKey])
  useLayoutEffect(() => {
    if (!connected && room?.startsWith('bilibili:')) biliSnapshots.current.delete(room.slice(9))
  }, [room, connected])
  useEffect(() => apiClient.subscribeFeatures(event => {
    if (event.topic === 'bilibili-lottery-invalidated') biliSnapshots.current.clear()
  }), [])
  useLayoutEffect(() => {
    session.setPlatformActivityMatcher(message => {
      if (message.platform === 'douyin' && douyin?.foldComments) {
        const clue = douyin.matchComment(message)
        return clue ? `${clue.room}:${clue.roomId}:${clue.activityId}` : null
      }
      if (message.platform === 'bilibili') {
        const sample = biliSnapshots.current.get(message.room.slice(9))
        const clue = sample && matchBilibiliLotteryMessage({ ...message, platform: 'bilibili' }, [sample])
        return clue ? `bilibili:${clue.room}:${clue.activityId}` : null
      }
      return null
    })
    return () => session.setPlatformActivityMatcher(null)
  }, [session, douyin])
  useEffect(() => {
    if (connected && huyaReminderGuard.shouldRemind(huyaOnTv ?? null, huyaReminders, Date.now())) {
      notify(`虎牙上电视：${huyaOnTv?.activity?.prize || '活动已开始'}`)
    }
  }, [connected, huyaOnTv, huyaReminders, huyaReminderGuard, notify])
  return {
    hasBilibili: sources.length > 0,
    cards: <>
      {sources.length > 0 && <BilibiliLotteryCards sources={sources} client={apiClient}
        onSnapshot={recordSnapshot} onReminder={value => notify(`哔哩哔哩天选福袋：${value.activity?.prize ?? ''}`)} />}
      {douyin && <DouyinLotteryCard view={douyin} />}
      {room?.startsWith('huya:') && <HuyaOnTvCard room={room} snapshot={huyaOnTv ?? null} connected={connected}
        reminders={huyaReminders} onRemindersChange={setHuyaReminders} openOfficialRoom={async target => {
          const result = await apiClient.feature('openHuyaOnTvRoom', { room: target })
          return result.ok ? { ok: true } : { ok: false, message: '暂时无法打开该虎牙房间' }
        }} />}
    </>,
  }
}
