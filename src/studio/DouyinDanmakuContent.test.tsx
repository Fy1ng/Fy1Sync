import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { DouyinMessageMetadata } from '../../server/danmaku/douyinProtocol'
import { DouyinDanmakuIdentity, DouyinDanmakuText } from './DouyinDanmakuContent'

const emoji: DouyinMessageMetadata = {
  roomId: '9000000000000000001', method: 'WebcastEmojiChatMessage',
  emoji: { fallback: '[合成表情]', images: [{ url: 'https://p3-webcast.douyinpic.com/synthetic.webp', fallback: '[合成表情]' }] },
}

describe('Douyin danmaku content', () => {
  it('keeps emoji text when the app has no image or an image load fails', () => {
    const { rerender } = render(<DouyinDanmakuText text="[合成表情]" douyin={emoji} />)
    expect(screen.getByText('[合成表情]')).toBeInTheDocument()
    rerender(<DouyinDanmakuText text="[合成表情]" douyin={emoji} imageSrc="/images/synthetic.webp" />)
    expect(screen.getByRole('img', { name: '[合成表情]' })).toHaveAttribute('src', '/images/synthetic.webp')
    fireEvent.error(screen.getByRole('img'))
    expect(screen.getByText('[合成表情]')).toBeInTheDocument()
    rerender(<DouyinDanmakuText text="聊天 🦆" />)
    expect(screen.getByText('聊天 🦆')).toBeInTheDocument()
  })

  it('only shows a verified current-anchor fan badge, independently of consumption level', () => {
    const liveFansClub = { name: '合成团', membership: 'member' as const, lit: false, level: 8, currentRoom: true }
    const clubs: DouyinMessageMetadata = { roomId: emoji.roomId, method: 'WebcastChatMessage', sender: { consumptionLevel: 23, liveFansClub } }
    const { rerender } = render(<DouyinDanmakuIdentity douyin={clubs} />)
    expect(screen.getByText('消费 23 级')).toBeInTheDocument()
    expect(screen.getByText('合成团 8 级 未点亮')).toBeInTheDocument()
    rerender(<DouyinDanmakuIdentity douyin={{ ...clubs, sender: { consumptionLevel: 23, liveFansClub: { ...liveFansClub, currentRoom: null } } }} />)
    expect(screen.queryByText(/合成团/)).toBeNull()
    expect(screen.getByText('消费 23 级')).toBeInTheDocument()
  })
})
