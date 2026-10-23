/**
 * The chat list: every danmaku released for the current commentary playhead, newest at the
 * bottom, in the sidebar under the sync controls.
 *
 * It is windowed. A busy room releases hundreds of messages a minute and the session keeps
 * the last CHAT_HISTORY_LIMIT; rendering them all would put thousands of nodes in the
 * sidebar. Only the visible rows plus a small overscan are in the DOM.
 *
 * Scroll follows the bottom until the user scrolls up. Then it holds still — new messages
 * do not move what they are reading — and a "N 条新消息" button takes them back down.
 * Messages come from the session's chat feed, not the snapshot: that one re-renders the
 * page and chat changes every frame.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useSession } from '../app/SessionContext'
import { anchoredScrollTop, chatWindow, CHAT_ROW_HEIGHT, isPinned } from './chatWindow'
import { DouyuMessageComposer, useDouyuMessageComposer } from './DouyuMessageComposer'

export function ChatList({ connected, room }: { connected: boolean; room: string | null }): React.ReactNode {
  const session = useSession()
  const composer = useDouyuMessageComposer({ connected, room })
  const subscribe = useCallback((listener: () => void) => session.subscribeChat(listener), [session])
  const messages = useSyncExternalStore(subscribe, () => session.chatHistory())
  const total = useSyncExternalStore(subscribe, () => session.chatCount())

  const scroller = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const pinned = useRef(true)
  const seen = useRef({ total, length: messages.length })
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    const node = scroller.current
    if (!node) return
    const measure = (): void => setViewport(node.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const height = messages.length * CHAT_ROW_HEIGHT

  // Before paint, so a scrolled-up reader never sees the list jump and come back.
  useLayoutEffect(() => {
    const node = scroller.current
    const previous = seen.current
    seen.current = { total, length: messages.length }
    if (!node) return
    const arrived = Math.max(0, total - previous.total)
    // Cleared history (disconnect) reads as a total that did not move while length fell.
    const droppedFromFront = arrived === 0 && messages.length < previous.length
      ? previous.length
      : Math.max(0, previous.length + arrived - messages.length)
    const next = anchoredScrollTop({ pinned: pinned.current, scrollTop: node.scrollTop, viewport: node.clientHeight, height, droppedFromFront })
    if (Math.abs(next - node.scrollTop) >= 1) node.scrollTop = next
    setScrollTop(node.scrollTop)
    if (!pinned.current && arrived > 0) setUnread((count) => count + arrived)
    if (messages.length === 0) setUnread(0)
  }, [total, messages.length, height])

  const jumpToLatest = (): void => {
    const node = scroller.current
    if (!node) return
    pinned.current = true
    setUnread(0)
    node.scrollTop = node.scrollHeight
  }

  const { start, end } = chatWindow(messages.length, scrollTop, viewport)
  const rows = messages.slice(start, end)

  return (
    <section className="chat-panel" aria-label="弹幕列表">
      <header className="chat-header">
        <h3>弹幕列表</h3>
        <span className="chat-count">{messages.length > 0 ? `${messages.length} 条` : ''}</span>
      </header>
      <div className="chat-feed">
        <div
          className="chat-scroller"
          ref={scroller}
          role="log"
          aria-live="off"
          aria-label="已显示的弹幕"
          tabIndex={0}
          onScroll={(event) => {
            const node = event.currentTarget
            pinned.current = isPinned(node.scrollTop, node.clientHeight, node.scrollHeight)
            if (pinned.current) setUnread(0)
            setScrollTop(node.scrollTop)
          }}
        >
          {messages.length === 0 ? (
            <p className="chat-empty">{connected ? '弹幕会随解说画面的进度出现在这里.' : '连接斗鱼房间后, 这里会列出弹幕.'}</p>
          ) : (
            <div className="chat-track" style={{ height }}>
              {rows.map((message, offset) => (
                <div
                  key={message.id}
                  className="chat-row"
                  style={{ transform: `translateY(${(start + offset) * CHAT_ROW_HEIGHT}px)` }}
                  title={`${message.user}: ${message.text}`}
                >
                  <span className="chat-user">{message.user}</span>
                  <span className="chat-text">{message.text}</span>
                  <button type="button" className="chat-repeat" disabled={!composer.canSendText(message.text)}
                    aria-label={`+1 复读 ${message.user} 的弹幕`}
                    title={composer.repeatProblem(message.text) ?? '发送一次这条弹幕'}
                    onClick={() => { void composer.repeat(message.text) }}>+1</button>
                </div>
              ))}
            </div>
          )}
        </div>
        {unread > 0 && (
          <button type="button" className="chat-jump" onClick={jumpToLatest}>
            {unread > 99 ? '99+' : unread} 条新消息
          </button>
        )}
      </div>
      <DouyuMessageComposer controller={composer} />
    </section>
  )
}
