import type { DanmakuMessage } from '../core/danmakuTimeline'
import { hasLocalPhantomIdentity, type DouyuLocalIdentitySettings, type LocalGiftEffect } from '../core/douyuLocalEffects'
import './DouyuLocalEffects.css'

const IDENTITY_TITLE = '本地幻神装扮, 仅在本应用显示, 不改变真实身份或斗鱼权益.'

/** The badge lives beside the sender/text, never inside the message used by +1. */
export function DouyuLocalIdentityBadge({ message, settings }: {
  message: Pick<DanmakuMessage, 'sender' | 'gift'>
  settings: DouyuLocalIdentitySettings
}): React.ReactNode {
  if (!hasLocalPhantomIdentity(message, settings)) return null
  return <span className="douyu-local-identity" title={IDENTITY_TITLE}>本地幻神</span>
}

/** DOM counterpart for the existing frame-driven danmaku overlay. */
export function createLocalIdentityBadge(): HTMLSpanElement {
  const badge = document.createElement('span')
  badge.className = 'douyu-local-identity'
  badge.textContent = '本地幻神'
  badge.title = IDENTITY_TITLE
  return badge
}

function RocketArtwork(): React.ReactNode {
  return <span className="douyu-local-rocket" aria-hidden="true">
    <span className="douyu-local-rocket-body" />
    <span className="douyu-local-rocket-window" />
    <span className="douyu-local-rocket-flame" />
  </span>
}

/** A clearly labelled settings preview, with no synthetic send or chat event. */
export function DouyuLocalGiftPreview(): React.ReactNode {
  return <div className="douyu-local-gift douyu-local-gift-preview" data-motion="reduced">
    <RocketArtwork />
    <div className="douyu-local-gift-copy">
      <strong className="douyu-local-gift-title">本地超火特效</strong>
      <span className="douyu-local-gift-source">样式预览 / 实际礼物仍为荧光棒</span>
    </div>
  </div>
}

/**
 * Text-only insertion into a fixed CSS illustration. Received URLs, image paths and
 * HTML are never used. The subtitle always shows the actual gift and quantity.
 */
export function createLocalGiftEffectNode(effect: LocalGiftEffect): HTMLDivElement {
  const node = document.createElement('div')
  node.className = 'douyu-local-gift'
  node.dataset.localEffect = 'super-rocket'
  node.dataset.motion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'reduced'
    : 'normal'
  const rocket = document.createElement('span')
  rocket.className = 'douyu-local-rocket'
  rocket.setAttribute('aria-hidden', 'true')
  for (const part of ['body', 'window', 'flame']) {
    const detail = document.createElement('span')
    detail.className = `douyu-local-rocket-${part}`
    rocket.appendChild(detail)
  }
  const copy = document.createElement('div')
  copy.className = 'douyu-local-gift-copy'
  const title = document.createElement('strong')
  title.className = 'douyu-local-gift-title'
  title.textContent = '本地超火特效'
  const source = document.createElement('span')
  source.className = 'douyu-local-gift-source'
  // Gift facts precede the ellipsized sender so a long nickname cannot conceal the
  // original gift or make this cosmetic rocket look like an actual rocket donation.
  source.textContent = `${effect.originalGift} x ${effect.count} / ${effect.senderName}`
  source.title = source.textContent
  copy.append(title, source)
  node.append(rocket, copy)
  return node
}
