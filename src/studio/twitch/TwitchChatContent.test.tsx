import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { TwitchChatContent } from './TwitchChatContent'
import type { TwitchChatEvent } from '../../core/twitchChat'

const event: TwitchChatEvent = {
  kind: 'chat', id: 'twitch:88:original', room: 'twitch:99', receivedAt: 1,
  message: { broadcasterId: '99', messageId: 'local' },
  source: { broadcasterId: '88', login: 'fixture_source', displayName: 'Fixture', messageId: 'original' },
  sourceOnly: false, sender: { id: '4', login: null, displayName: 'Tester', color: null },
  badges: [{ setId: 'moderator', id: '1', info: '' }],
  sourceBadges: [{ setId: 'subscriber', id: '6', info: '' }],
  text: 'Hey Kappa',
  fragments: [{ type: 'text', text: 'Hey ' }, { type: 'emote', text: 'Kappa', emote: { id: '25', ownerId: null, setId: null, animated: false } }],
  reply: null, notice: null, bits: null, rewardId: null, messageType: 'text',
}

it('keeps native emote text and badge labels when the asset route is unavailable or an asset fails', () => {
  const view = render(<TwitchChatContent event={event} />)
  expect(screen.getByText('Kappa', { exact: false })).toBeInTheDocument()
  expect(screen.getByText('subscriber')).toBeInTheDocument()
  expect(screen.queryAllByRole('img')).toEqual([])
  const badges = (title: string, name: string) => [{ setId: 'subscriber', id: '6', title,
    imageUrl: `https://static-cdn.jtvnw.net/badges/v1/${name}/2` }]
  view.rerender(<TwitchChatContent event={event}
    badgeAssets={{ channels: new Map([['88', badges('Source Badge', 'source')], ['99', badges('Delivery Badge', 'delivery')]]) }}
    resolveAsset={url => `/fixture${new URL(url).pathname}`} />)
  expect(screen.getByRole('img', { name: 'Source Badge' })).toHaveAttribute('src', '/fixture/badges/v1/source/2')
  const emote = screen.getByRole('img', { name: 'Kappa' })
  expect(emote).toHaveAttribute('src', '/fixture/emoticons/v2/25/static/dark/1.0')
  fireEvent.error(emote)
  expect(screen.getByText('Kappa', { exact: false })).toBeInTheDocument()
  expect(screen.queryByRole('img', { name: 'Kappa' })).toBeNull()
})
