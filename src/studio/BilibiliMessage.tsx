import { useEffect, useState } from 'react'
import type { BilibiliMetadata, BilibiliSender } from '../core/bilibiliMetadata'
import { emoteSource, splitBilibiliText } from '../core/bilibiliMetadata'
import { visibleBilibiliSuperChats, type createBilibiliSuperChatState } from '../core/bilibiliSuperChats'
import './bilibili.css'

export function BilibiliMessage({ text, emotes }: BilibiliMetadata & { text: string }): React.ReactNode {
  return <>{splitBilibiliText(text, emotes).map((part, index) => part.url
    ? <EmoteImage key={`${index}:${part.url}`} url={part.url} text={part.text} />
    : part.text)}</>
}

function EmoteImage({ url, text }: { url: string; text: string }): React.ReactNode {
  const [failed, setFailed] = useState(false)
  const src = emoteSource(url)
  return failed || !src ? text : <img className="bili-emote" src={src} alt={text} title={text} referrerPolicy="no-referrer" onError={() => setFailed(true)} />
}

export function fillBilibiliMessage(node: HTMLElement, text: string, metadata: BilibiliMetadata): void {
  for (const part of splitBilibiliText(text, metadata.emotes)) {
    const src = emoteSource(part.url)
    const document = node.ownerDocument
    if (!src) {
      node.append(document.createTextNode(part.text))
      continue
    }
    const image = document.createElement('img')
    image.className = 'bili-emote'
    image.src = src
    image.alt = part.text
    image.title = part.text
    image.referrerPolicy = 'no-referrer'
    image.onerror = () => image.replaceWith(document.createTextNode(part.text))
    node.append(image)
  }
}

export function BilibiliSenderBadges({ sender }: { sender?: BilibiliSender }): React.ReactNode {
  if (!sender) return null
  const guardLabels = ['', '总督', '提督', '舰长']
  const medal = sender.medal
  const origin = medal?.anchorName ?? (medal?.anchorUid ? `UID ${medal.anchorUid}` : '主播未知')
  const worn = medal?.worn === undefined ? '佩戴状态未知' : medal.worn ? '已佩戴' : '未佩戴'
  return <span className="bili-sender">
    {sender.admin && <span>房管</span>}
    {sender.gloryLevel !== undefined && <span>直播荣耀 {sender.gloryLevel}</span>}
    {sender.siteLevel !== undefined && <span>主站等级 {sender.siteLevel}</span>}
    {sender.guardLevel ? <span>{guardLabels[sender.guardLevel]}</span> : null}
    {medal && <span title={`${origin} / ${worn}`}>{medal.name} {medal.level}</span>}
  </span>
}

export function BilibiliGiftLabel({ gift }: { gift: NonNullable<BilibiliMetadata['bilibiliGift']> }): React.ReactNode {
  const payment = gift.payment === 'paid' ? '付费礼物' : gift.payment === 'free' ? '免费礼物' : '付费属性未知'
  return <span>{gift.name}{gift.quantity === undefined ? ' (数量未知)' : ` ×${gift.quantity}`} · {payment}
    {gift.fromBag ? ' · 背包' : ''}{gift.comboTotal === undefined ? '' : ` · 连击累计 ${gift.comboTotal}`}
  </span>
}

export function BilibiliSuperChatFeed({ room, state }: {
  room: string
  state: ReturnType<typeof createBilibiliSuperChatState>
}): React.ReactNode {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const actual = Date.now()
    const until = Math.min(...visibleBilibiliSuperChats(state, room, actual).map(item => item.expiresAt))
    if (!Number.isFinite(until)) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, until - actual))
    return () => clearTimeout(timer)
  }, [state, room, now])
  const active = visibleBilibiliSuperChats(state, room, Math.max(now, Date.now()))
  if (!active.length) return null
  return <div className="bili-sc-feed" aria-label="醒目留言">{active.map(({ message }) =>
    <article className="bili-sc-card" key={message.id} style={{ backgroundColor: message.superChat.background, color: message.superChat.color }}>
      <header><span>{message.username}</span><span>¥{message.superChat.price}</span></header>
      <p>{message.text}</p>
    </article>)}</div>
}
