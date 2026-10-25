/**
 * The room's chat, released in step with the voice, and a line to send into it.
 *
 * Windowed: a busy room releases hundreds of messages a minute and only the visible rows are
 * in the DOM. It follows the bottom until the reader scrolls up, then holds still and
 * offers a way back down.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { anchoredScrollTop, chatWindow, isPinned } from '../ui/chatWindow'
import { useDouyuMessageComposer } from '../ui/DouyuMessageComposer'
import { Icon } from './kit'

const ROW = 30

export function ChatDrawer({ onClose, onOpenDouyu }: { onClose: () => void; onOpenDouyu: () => void }): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const { danmaku } = snapshot
  const composer = useDouyuMessageComposer({ connected: danmaku.connected, room: danmaku.room })
  const subscribe = useCallback((listener: () => void) => session.subscribeChat(listener), [session])
  const messages = useSyncExternalStore(subscribe, () => session.chatHistory())
  const total = useSyncExternalStore(subscribe, () => session.chatCount())

  const scroller = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const pinned = useRef(true)
  const seen = useRef({ total, length: messages.length })
  const [unread, setUnread] = useState(0)
  const height = messages.length * ROW

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

  useLayoutEffect(() => {
    const node = scroller.current
    const previous = seen.current
    seen.current = { total, length: messages.length }
    if (!node) return
    const arrived = Math.max(0, total - previous.total)
    const droppedFromFront = arrived === 0 && messages.length < previous.length
      ? previous.length
      : Math.max(0, previous.length + arrived - messages.length)
    const next = anchoredScrollTop({ pinned: pinned.current, scrollTop: node.scrollTop, viewport: node.clientHeight, height, droppedFromFront })
    if (Math.abs(next - node.scrollTop) >= 1) node.scrollTop = next
    setScrollTop(node.scrollTop)
    if (!pinned.current && arrived > 0) setUnread((count) => count + arrived)
    if (messages.length === 0) setUnread(0)
  }, [total, messages.length, height])

  const { start, end } = chatWindow(messages.length, scrollTop, viewport, ROW)
  const rows = messages.slice(start, end)
  const composing = useRef(false)

  return (
    <aside className="drawer" aria-label="弹幕">
      <header className="drawer-head">
        <span className="drawer-title">
          <span className="drawer-dot" data-on={danmaku.connected} aria-hidden="true" />
          {danmaku.room ? `房间 ${danmaku.room}` : '弹幕'}
        </span>
        <span className="num muted">{messages.length > 0 ? messages.length : ''}</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="收起弹幕" title="收起（C）">
          <Icon name="close" />
        </button>
      </header>

      <div className="drawer-feed">
        <div className="drawer-scroll" ref={scroller} role="log" aria-live="off" aria-label="弹幕列表" tabIndex={0}
          onScroll={(event) => {
            const node = event.currentTarget
            pinned.current = isPinned(node.scrollTop, node.clientHeight, node.scrollHeight, ROW)
            if (pinned.current) setUnread(0)
            setScrollTop(node.scrollTop)
          }}>
          {messages.length === 0 ? (
            <p className="drawer-empty">
              {danmaku.connected ? '弹幕会跟着解说的进度出现' : danmaku.room ? '正在连接…' : '载入斗鱼解说后，这里显示它的弹幕'}
            </p>
          ) : (
            <div style={{ height, position: 'relative' }}>
              {rows.map((message, offset) => (
                <div key={message.id} className={`msg ${message.gift ? 'is-gift' : ''}`.trim()}
                  style={{ transform: `translateY(${(start + offset) * ROW}px)` }} title={`${message.user}：${message.text}`}>
                  <span className="msg-user">{message.user}</span>
                  <span className="msg-text">{message.text}</span>
                  {!message.gift && (
                    <button type="button" className="msg-plus" disabled={!composer.canSendText(message.text)}
                      aria-label={`跟一条：${message.text}`} title={composer.repeatProblem(message.text) ?? '把这条原样发一遍'}
                      onClick={() => void composer.repeat(message.text)}>+1</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        {unread > 0 && (
          <button type="button" className="drawer-jump" onClick={() => {
            const node = scroller.current
            if (!node) return
            pinned.current = true
            setUnread(0)
            node.scrollTop = node.scrollHeight
          }}>{unread > 99 ? '99+' : unread} 条新弹幕</button>
        )}
      </div>

      <form className="say" onSubmit={(event) => { event.preventDefault(); if (!composing.current) void composer.sendDraft() }}>
        <textarea rows={1} value={composer.draft} disabled={!composer.canEdit} aria-label="弹幕内容"
          placeholder={composer.canEdit ? '发条弹幕' : !composer.account?.loggedIn ? '登录斗鱼后可以发送' : danmaku.connected ? '稍等…' : '连上弹幕后可以发送'}
          spellCheck={false}
          onChange={(event) => composer.setDraft(event.target.value)}
          onFocus={() => { void composer.refreshAccounts() }}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
            event.preventDefault()
            void composer.sendDraft()
          }} />
        <button type="submit" className="say-send" disabled={!composer.canSendText(composer.draft)}>发送</button>
        <p className="say-meta">
          {composer.account?.loggedIn
            ? <span>以 {composer.account.label} 发送</span>
            : <button type="button" className="link-btn" onClick={onOpenDouyu}>登录斗鱼</button>}
          {composer.remaining > 0 && <span className="num">{composer.remaining}s</span>}
          {composer.draft.length > 400 && <span className="num">{composer.draft.length}/500</span>}
        </p>
        {composer.draft.length > 0 && composer.draftProblem && <p className="say-note is-warn">{composer.draftProblem}</p>}
        {composer.notice && <p className="say-note" data-state={composer.notice.status} role="status">{composer.notice.message}</p>}
      </form>
    </aside>
  )
}
