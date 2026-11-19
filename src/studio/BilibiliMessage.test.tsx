import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BilibiliMessage, BilibiliSenderBadges, BilibiliSuperChatFeed, fillBilibiliMessage } from './BilibiliMessage'
import { BilibiliRoomInsights } from './insights/BilibiliRoomInsights'
import { createBilibiliSuperChatState, updateBilibiliSuperChats } from '../core/bilibiliSuperChats'
import { parseBilibiliRoomEvent, type BilibiliChatMessage, type BilibiliSuperChatRemoval } from '../../server/danmaku/bilibiliEvents'
import { bilibiliReplay, bilibiliReplayAt as at, bilibiliReplayRoom as canonical } from '../../server/danmaku/bilibiliReplayFixture'
import { bilibiliWatchEvidenceStatus, summarizeBilibiliRoom } from '../../server/platforms/bilibiliRoomInsights'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('renders inline and full images, preserves their text on failure and treats text as text', () => {
  const inline = parseBilibiliRoomEvent(bilibiliReplay.inline, canonical, at) as BilibiliChatMessage
  const image = parseBilibiliRoomEvent(bilibiliReplay.image, canonical, at) as BilibiliChatMessage
  const view = render(<BilibiliMessage {...inline} />)
  const inlineImage = screen.getByRole('img', { name: '[笑]' })
  expect(inlineImage.getAttribute('src')).toMatch(/^app:\/\/app\/bilibili-emote\?url=/)
  fireEvent.error(inlineImage)
  expect(view.container.textContent).toBe('你好[笑]')
  view.rerender(<BilibiliMessage {...image} />)
  expect(screen.getByRole('img', { name: '[整条表情]' })).toBeTruthy()
  const node = document.createElement('span')
  fillBilibiliMessage(node, '<script>[笑]', inline)
  expect(node.querySelector('script')).toBeNull()
  node.querySelector('img')!.dispatchEvent(new Event('error'))
  expect(node.textContent).toBe('<script>[笑]')
})

it('renders independent live glory, site, room admin, guard and medal wearing fields', () => {
  const message = parseBilibiliRoomEvent(bilibiliReplay.inline, canonical, at) as BilibiliChatMessage
  render(<BilibiliSenderBadges sender={message.bilibiliSender} />)
  for (const label of ['直播荣耀 18', '主站等级 6', '房管', '舰长', '测试勋章 13']) {
    expect(screen.getByText(label)).toBeTruthy()
  }
  expect(screen.getByTitle('UID 1001，未佩戴').textContent).toBe('测试勋章 13')
})

it('expires SC after its original display interval and scopes removals by room and SC ID', () => {
  vi.useFakeTimers()
  vi.setSystemTime(at + 10_000)
  const room = `bilibili:${canonical}`
  const message = parseBilibiliRoomEvent(bilibiliReplay.superChat, canonical, at) as BilibiliChatMessage
  const state = updateBilibiliSuperChats(createBilibiliSuperChatState(room), message, Date.now())
  expect(state.active[0]?.expiresAt).toBe(at + 90_000)
  const view = render(<BilibiliSuperChatFeed room={room} state={state} />)
  expect(screen.getByText('测试醒目留言')).toBeTruthy()
  const removal = parseBilibiliRoomEvent(bilibiliReplay.deleteSuperChat, canonical, at + 12_000) as BilibiliSuperChatRemoval
  expect(updateBilibiliSuperChats(state, { ...removal, room: 'bilibili:123457' }, Date.now())).toBe(state)
  const removed = updateBilibiliSuperChats(state, removal, Date.now())
  expect(updateBilibiliSuperChats(removed, message, Date.now()).active).toEqual([])
  view.rerender(<BilibiliSuperChatFeed room={room} state={removed} />)
  expect(screen.queryByText('测试醒目留言')).toBeNull()
  view.rerender(<BilibiliSuperChatFeed room={room} state={state} />)
  act(() => vi.advanceTimersByTime(80_000))
  expect(screen.queryByText('测试醒目留言')).toBeNull()
  expect(updateBilibiliSuperChats(createBilibiliSuperChatState(room), message, Date.now()).active).toEqual([])
})

it('shows last room count and keeps all personal watch fields unknown', () => {
  const room = `bilibili:${canonical}`
  const data = summarizeBilibiliRoom({
    room, messages: [], rate: { receivedLastMinute: 0 }, capacity: 100, truncated: false, checkedAt: at,
  }, { watched: { count: 1024, checkedAt: at } })
  const watch = bilibiliWatchEvidenceStatus({ room: canonical, live: true, liveStartedAt: at }, 'test-slot', at)
  const open = vi.fn()
  const view = render(<BilibiliRoomInsights room={room} data={data} watch={watch} onOpenOfficialRoom={open} />)
  expect(screen.getByText('全房观看计数')).toBeTruthy()
  expect(screen.getByText('1024')).toBeTruthy()
  expect(screen.getAllByText('未收到')).toHaveLength(2)
  expect(screen.getByText(/个人看播任务均未知/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '打开官方直播间' }))
  expect(open).toHaveBeenCalledOnce()
  view.rerender(<BilibiliRoomInsights room="bilibili:123457" data={data} watch={watch} />)
  expect(screen.queryByText('1024')).toBeNull()
})
