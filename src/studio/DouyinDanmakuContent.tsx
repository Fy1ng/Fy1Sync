import { useState, type ReactNode } from 'react'
import type { DouyinMessageMetadata } from '../../server/danmaku/douyinProtocol'

export function DouyinDanmakuText({ text, douyin, imageSrc }: {
  text: string
  douyin?: DouyinMessageMetadata
  imageSrc?: string
}): ReactNode {
  const [failedSrc, setFailedSrc] = useState<string>()
  const emoji = douyin?.method === 'WebcastEmojiChatMessage' ? douyin.emoji : undefined
  const fallback = emoji?.fallback || text
  if (emoji?.images.length !== 1 || !emoji.images[0]?.url || !imageSrc || imageSrc === failedSrc) return fallback
  return <img src={imageSrc} alt={fallback} loading="lazy" decoding="async" referrerPolicy="no-referrer" draggable={false}
    style={{ height: '1.4em', maxWidth: '3em', objectFit: 'contain', verticalAlign: 'middle' }}
    onError={() => setFailedSrc(imageSrc)} />
}

export function DouyinDanmakuIdentity({ douyin }: { douyin?: DouyinMessageMetadata }): ReactNode {
  const grade = douyin?.sender?.consumptionLevel
  const club = douyin?.sender?.liveFansClub
  const roomClub = club?.currentRoom === true && club.membership === 'member' ? club : undefined
  return <>
    {grade !== undefined && <span>消费 {grade} 级</span>}
    {roomClub && <span>
      {roomClub.name || '直播粉丝团'}
      {roomClub.level !== undefined && ` ${roomClub.level} 级`}
      {roomClub.lit !== null && (roomClub.lit ? ' 已点亮' : ' 未点亮')}
    </span>}
  </>
}
