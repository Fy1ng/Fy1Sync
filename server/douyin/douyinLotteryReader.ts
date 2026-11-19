import { safeFetch } from '../safeFetch'
import { readPlatformBytes } from '../platformResponse'
import type { ProxyConfig } from '../config'
import type { NetworkContext } from '../networkPolicy'
import type { DouyinDanmakuRoom } from '../platforms/douyinDanmaku'
import { asRecord } from '../platforms/douyinPage'
import { douyinMessageRoom } from '../../src/core/douyinMessage'
import {
  douyinLotteryId,
  type DouyinLotteryActivity,
  type DouyinLotterySnapshot,
  type DouyinLotteryTarget,
} from '../../src/core/douyinLottery'

export const DOUYIN_LOTTERY_MAX_BYTES = 128 * 1024

const cleanText = (value: unknown, max = 512): string =>
  typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : ''

function count(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function readId(record: Record<string, unknown>, field: string): string | null {
  const stringId = record[`${field}_str`]
  const raw = record[field]
  const numericId = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw
  if (stringId !== undefined) {
    if (!douyinLotteryId(stringId) || (douyinLotteryId(numericId) && numericId !== stringId)) return null
    return stringId
  }
  return douyinLotteryId(numericId) ? numericId : null
}

export function douyinLotteryOfficialUrl(room: unknown): string {
  if (!douyinMessageRoom(room)) throw new Error('Invalid Douyin room')
  return `https://live.douyin.com/${room.slice(7)}`
}

export function parseDouyinLottery(raw: unknown, target: DouyinLotteryTarget, observedAt: number): DouyinLotterySnapshot {
  const { room, roomId } = target
  const noActivity = (status: 'unavailable' | 'empty'): DouyinLotterySnapshot =>
    ({ room, roomId, observedAt, status, activity: null })
  if (!douyinMessageRoom(room) || !douyinLotteryId(roomId)
    || !Number.isSafeInteger(observedAt) || observedAt < 0) return noActivity('unavailable')
  const envelope = asRecord(raw)
  if (envelope.status_code !== 0 || !isRecord(envelope.data)) return noActivity('unavailable')
  const data = envelope.data
  if (!Object.keys(data).length || data.lottery_info === null) return noActivity('empty')
  const info = data.lottery_info
  if (!isRecord(info)) return noActivity('unavailable')
  if (!Object.keys(info).length) return noActivity('empty')
  const id = readId(info, 'lottery_id')
  if (!id || readId(info, 'room_id') !== roomId) return noActivity('unavailable')
  const status = count(info.status)
  if (status === null || status > 5) return noActivity('unavailable')
  if (status !== 1) return noActivity('empty')
  const prize = asRecord(info.prize_info)
  const prizeType = count(prize.type)
  if (prizeType !== 1 && prizeType !== 2) return noActivity('unavailable')
  const platformTime = count(info.current_time)
  const drawTime = count(info.draw_time)
  if (platformTime === null || drawTime === null || platformTime < 1_500_000_000 || platformTime > 4_000_000_000
    || drawTime - platformTime > 86_400) return noActivity('unavailable')
  if (drawTime <= platformTime) return noActivity('empty')
  if (!Array.isArray(info.conditions) || info.conditions.length > 16) return noActivity('unavailable')
  const conditions: DouyinLotteryActivity['conditions'] = []
  const comments: string[] = []
  let webSupport: DouyinLotteryActivity['webSupport'] = 'unknown'
  for (const rawCondition of info.conditions) {
    const condition = asRecord(rawCondition)
    const type = count(condition.type)
    if (type === null || type > 1000) return noActivity('unavailable')
    const content = cleanText(condition.content, 480)
    const level = count(condition.min_fans_level)
    const labels: Record<number, string> = {
      3: content.trim() ? `发送指定评论：${content}` : '发送指定评论',
      4: '赠送指定礼物',
      5: '加入直播粉丝团',
      6: '在官方入口参与',
      7: level !== null ? `直播粉丝团等级至少 ${level} 级` : '达到指定直播粉丝团等级',
      8: '点亮直播粉丝团',
      9: '分享直播间',
      11: '会员限定',
    }
    conditions.push({ type, label: labels[type] ?? (cleanText(condition.description) || '其他条件，请在官方确认') })
    if (type === 3) comments.push(content.trim() ? content : '')
    if (![3, 5, 6, 7, 8, 9, 11].includes(type)) webSupport = 'app-may-be-required'
  }
  return {
    room, roomId, observedAt, status: 'active',
    activity: {
      id, platformTime, drawTime, conditions, webSupport,
      commentCommand: comments.length === 1 ? comments[0] || null : null,
      prize: {
        kind: prizeType === 1 ? 'virtual-currency' : 'physical',
        name: cleanText(prize.name).trim() || (prizeType === 1 ? '虚拟币奖励' : '实物奖品'),
        description: cleanText(prize.prize_description).trim(),
        count: count(info.prize_count),
        winners: count(info.lucky_count),
      },
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export interface DouyinLotteryReaderDeps {
  proxy: ProxyConfig
  network?: NetworkContext
  fetchImpl?: typeof fetch
  resolve?: (host: string) => Promise<string[]>
  now?: () => number
}

export async function readDouyinLottery(
  metadata: Pick<DouyinDanmakuRoom, 'webRoom' | 'roomId' | 'cookie' | 'userAgent'>,
  parent: AbortSignal,
  deps: DouyinLotteryReaderDeps,
): Promise<DouyinLotterySnapshot> {
  parent.throwIfAborted()
  const target = { room: `douyin:${metadata.webRoom}`, roomId: metadata.roomId }
  const now = deps.now ?? Date.now
  const unavailable = (): DouyinLotterySnapshot => ({ ...target, observedAt: now(), status: 'unavailable', activity: null })
  if (!douyinMessageRoom(target.room) || !douyinLotteryId(target.roomId)
    || !/^ttwid=[^;\x00-\x20\x7f]{1,4096}$/.test(metadata.cookie)) return unavailable()
  const roomUrl = douyinLotteryOfficialUrl(target.room)
  const url = new URL('/webcast/lottery/melon/lottery_info/', roomUrl)
  url.search = new URLSearchParams({
    aid: '6383', app_name: 'douyin_web', live_id: '1', device_platform: 'web',
    room_id: target.roomId, query_from: '1',
  }).toString()
  const signal = AbortSignal.any([parent, AbortSignal.timeout(10_000)])
  try {
    const result = await safeFetch(url.href, { ...deps.proxy, maxRedirects: 0 }, {
      method: 'GET', signal, network: deps.network, fetchImpl: deps.fetchImpl, resolve: deps.resolve,
      headers: { 'User-Agent': metadata.userAgent, Cookie: metadata.cookie, Referer: roomUrl, Accept: 'application/json' },
    })
    const response = result.response
    const length = response.headers.get('content-length')
    if (signal.aborted || result.finalUrl.href !== url.href || !response.ok
      || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
      || (length !== null && (!/^\d+$/.test(length) || Number(length) > DOUYIN_LOTTERY_MAX_BYTES))) {
      void response.body?.cancel().catch(() => {})
      parent.throwIfAborted()
      return unavailable()
    }
    const bytes = await readPlatformBytes(response, signal)
    parent.throwIfAborted()
    if (bytes.length > DOUYIN_LOTTERY_MAX_BYTES) return unavailable()
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return parseDouyinLottery(raw, target, now())
  } catch {
    parent.throwIfAborted()
    return unavailable()
  }
}
