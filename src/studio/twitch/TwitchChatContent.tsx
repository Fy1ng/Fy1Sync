import { useState } from 'react'
import { twitchEmoteUrl, type TwitchBadgeAsset, type TwitchChatEvent } from '../../core/twitchChat'

type AssetResolver = (officialUrl: string) => string | null

function ChatAsset({ url, text }: { url: string | null; text: string }) {
  const [failed, setFailed] = useState(false)
  return url && !failed
    ? <img src={url} alt={text} title={text} width={20} height={20} onError={() => setFailed(true)} />
    : <>{text}</>
}

export function TwitchChatContent({ event, badgeAssets, resolveAsset }: {
  event: TwitchChatEvent
  badgeAssets?: { global?: readonly TwitchBadgeAsset[]; channels?: ReadonlyMap<string, readonly TwitchBadgeAsset[]> }
  resolveAsset?: AssetResolver
}) {
  const sourceId = event.source.broadcasterId
  const useSource = event.sourceBadges !== null
  const badges = useSource ? event.sourceBadges ?? [] : event.badges
  const channelAssets = badgeAssets?.channels?.get(useSource ? sourceId : event.message.broadcasterId)
  return <>
    {badges.map((badge, index) => {
      const matches = (asset: TwitchBadgeAsset) => asset.setId === badge.setId && asset.id === badge.id
      const asset = channelAssets?.find(matches) ?? badgeAssets?.global?.find(matches)
      const url = asset ? resolveAsset?.(asset.imageUrl) ?? null : null
      const text = asset?.title ?? badge.setId
      return <span key={`${badge.setId}:${badge.id}:${index}`}><ChatAsset key={url} url={url} text={text} />{' '}</span>
    })}
    {event.reply?.text && <span title={event.reply.text}>回复 {event.reply.text} </span>}
    {event.notice?.systemText && <span>{event.notice.systemText}{event.text && ' '}</span>}
    {event.fragments.map((fragment, index) => {
      const officialUrl = twitchEmoteUrl(fragment)
      const url = officialUrl ? resolveAsset?.(officialUrl) ?? null : null
      return <ChatAsset key={`${index}:${url}`} url={url} text={fragment.text} />
    })}
  </>
}
