import { useState } from 'react'
import type { BilibiliMetadata } from '../core/bilibiliMetadata'
import { emoteSource, splitBilibiliText } from '../core/bilibiliMetadata'
import './bilibili.css'

export function BilibiliMessage({ text, emotes }: BilibiliMetadata & { text: string }): React.ReactNode {
  return <>{splitBilibiliText(text, emotes).map((part, i) => part.url
    ? <EmoteImage key={`${i}:${part.url}`} url={part.url} text={part.text} />
    : part.text)}</>
}
function EmoteImage({ url, text }: { url: string; text: string }): React.ReactNode {
  const [failed, setFailed] = useState(false)
  return failed ? text : <img className="bili-emote" src={emoteSource(url)} alt={text} title={text} referrerPolicy="no-referrer" onError={() => setFailed(true)} />
}
export function fillBilibiliMessage(node: HTMLElement, text: string, metadata: BilibiliMetadata): void {
  for (const part of splitBilibiliText(text, metadata.emotes)) {
    if (!part.url) { node.append(document.createTextNode(part.text)); continue }
    const image = document.createElement('img'); image.className = 'bili-emote'; image.src = emoteSource(part.url); image.alt = part.text; image.title = part.text
    image.onerror = () => image.replaceWith(document.createTextNode(part.text)); node.append(image)
  }
}
