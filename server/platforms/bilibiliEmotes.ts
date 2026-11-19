import { bilibiliCount, bilibiliId, bilibiliImageUrl, bilibiliRoomNumber, bilibiliText } from '../../src/core/bilibiliMetadata'
import { bilibiliObject, BilibiliWebError, fetchBilibiliWebData, type BilibiliCookieHeader } from './bilibiliWeb'

export type BilibiliEmoteCatalog = {
  platform: 'bilibili'
  room: string
  accountRef: string
  checkedAt: number
  sendPermission: 'unverified'
  packages: Array<{
    name: string
    emotes: Array<{ id?: string; text: string; url: string; requiredMedalLevel?: number }>
  }>
}

export function parseBilibiliEmotePackages(raw: unknown): BilibiliEmoteCatalog['packages'] {
  if (!Array.isArray(raw)) throw new BilibiliWebError('unavailable', 'B 站未返回可用的表情目录.')
  return raw.slice(0, 64).flatMap(item => {
    const group = bilibiliObject(item)
    const name = bilibiliText(group.pkg_name, 100)
    if (!name || !Array.isArray(group.emoticons)) return []
    const emotes = group.emoticons.slice(0, 256).flatMap(item => {
      const emote = bilibiliObject(item)
      const url = bilibiliImageUrl(emote.url)
      const text = bilibiliText(emote.emoji, 100)
      return url && text ? [{
        id: bilibiliId(emote.emoticon_id), text, url, requiredMedalLevel: bilibiliCount(emote.unlock_need_level, 1000),
      }] : []
    })
    return [{ name, emotes }]
  })
}

export async function readBilibiliEmoteCatalog(
  room: string, accountRef: string, cookieHeader: BilibiliCookieHeader, signal?: AbortSignal,
): Promise<BilibiliEmoteCatalog> {
  if (!bilibiliRoomNumber(room)) throw new BilibiliWebError('unavailable', 'B 站房间号无效.')
  if (!accountRef) throw new BilibiliWebError('login-required', '请先登录 B 站.')
  const data = await fetchBilibiliWebData(`https://api.live.bilibili.com/xlive/web-ucenter/v2/emoticon/GetEmoticons?platform=pc&room_id=${room}`, { cookieHeader, signal })
  return {
    platform: 'bilibili', room, accountRef, checkedAt: Date.now(), sendPermission: 'unverified',
    packages: parseBilibiliEmotePackages(data.data),
  }
}
