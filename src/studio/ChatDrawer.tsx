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
import type { DanmakuMessage } from '../core/danmakuTimeline'
import { useComposer } from './composer'
import { useDanmakuActions } from './danmakuActions'
import { useDanmakuRate } from './insights/RoomInsights'
import type { RecordsTab } from './records/DanmakuRecords'
import type { SettingsSection } from './SettingsSheet'
import { Icon, Popover } from './kit'
import { useSourceLoader } from './sources'
import { deliveryText } from './useStudioComposer'

const ROW = 30

export function ChatDrawer({ onClose, onOpenSettings, onOpenRecords }: {
  onClose: () => void
  onOpenSettings: (section: SettingsSection) => void
  onOpenRecords: (tab: RecordsTab, uid?: string) => void
}): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const { danmaku } = snapshot
  const readOnly = danmaku.room?.startsWith('huya:') === true
  const composer = useComposer()
  const { roomName } = useSourceLoader()
  const rate = useDanmakuRate(readOnly ? null : danmaku.room)
  // One menu for the whole list, placed beside the row it was opened from.
  const [rowMenu, setRowMenu] = useState<{ message: DanmakuMessage; top: number } | null>(null)
  const [rowNote, setRowNote] = useState<string | null>(null)
  const box = useRef<HTMLTextAreaElement | null>(null)
  const subscribe = useCallback((listener: () => void) => session.subscribeChat(listener), [session])
  const messages = useSyncExternalStore(subscribe, () => session.chatHistory())
  const total = useSyncExternalStore(subscribe, () => session.chatCount())

  const scroller = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const pinned = useRef(true)
  // Where this component last scrolled to. The scroll event that assignment fires must not
  // be read as the reader's own scroll: during a burst it can report a position short of a
  // bottom that has already moved on, which used to unpin the list for good.
  const placed = useRef<number | null>(null)
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
    const next = anchoredScrollTop({ pinned: pinned.current, scrollTop: node.scrollTop, viewport: node.clientHeight, height, droppedFromFront, row: ROW })
    if (Math.abs(next - node.scrollTop) >= 1) { node.scrollTop = next; placed.current = node.scrollTop }
    setScrollTop(node.scrollTop)
    if (!pinned.current && arrived > 0) setUnread((count) => count + arrived)
    if (messages.length === 0) setUnread(0)
  }, [total, messages.length, height])

  // A smaller viewport (the window, or the send box growing) keeps a pinned list at the bottom.
  useLayoutEffect(() => {
    const node = scroller.current
    if (!node || !pinned.current) return
    node.scrollTop = node.scrollHeight
    placed.current = node.scrollTop
  }, [viewport])

  // "回复" from the picture writes into the box; follow it there.
  useEffect(() => {
    if (composer.focusRequest === 0) return
    const node = box.current
    if (!node) return
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
  }, [composer.focusRequest])

  const { start, end } = chatWindow(messages.length, scrollTop, viewport, ROW)
  const rows = messages.slice(start, end)
  const composing = useRef(false)
  // Keep the menu in the feed's available half, including when its content grows.
  const menuAbove = rowMenu !== null && rowMenu.top > viewport / 2
  const menuEdge = rowMenu ? Math.max(8, Math.min(viewport - 8, rowMenu.top - (menuAbove ? ROW : 0))) : 8

  return (
    <aside className="drawer" aria-label="弹幕">
      <header className="drawer-head">
        <span className="drawer-title">
          <span className="drawer-dot" data-on={danmaku.connected} aria-hidden="true" />
          {roomName ? `房间 ${roomName}` : '弹幕'}
        </span>
        {rate !== null && <span className="num muted" title="每分钟收到的弹幕数">{Math.round(rate)} 条/分</span>}
        <span className="drawer-tools">
          {!readOnly && <button type="button" className="icon-btn" onClick={() => onOpenRecords('history')} aria-label="弹幕记录与收藏" title="弹幕记录与收藏">
            <Icon name="history" />
          </button>}
          {danmaku.room && !readOnly && (
            <button type="button" className="icon-btn" onClick={() => onOpenSettings('insights')} aria-label="房间数据" title="房间数据">
              <Icon name="stats" />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={() => onOpenSettings('general')} aria-label="设置" title="设置">
            <Icon name="gear" />
          </button>
        </span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="收起弹幕" title="收起（C）">
          <Icon name="close" />
        </button>
      </header>

      <div className="drawer-feed">
        <div className="drawer-scroll" ref={scroller} role="log" aria-live="off" aria-label="弹幕列表" tabIndex={0}
          onScroll={(event) => {
            const node = event.currentTarget
            const ours = placed.current !== null && Math.abs(node.scrollTop - placed.current) < 2
            placed.current = null
            if (!ours) pinned.current = isPinned(node.scrollTop, node.clientHeight, node.scrollHeight, ROW)
            if (pinned.current) setUnread(0)
            setScrollTop(node.scrollTop)
            setRowMenu(null)
          }}>
          {messages.length === 0 ? (
            <p className="drawer-empty">
              {danmaku.connected ? '弹幕将随解说进度显示' : danmaku.room ? '正在连接…' : '载入斗鱼或虎牙解说后显示弹幕'}
            </p>
          ) : (
            <div style={{ height, position: 'relative' }}>
              {rows.map((message, offset) => (
                <div key={message.id} className={`msg ${message.gift || message.huyaGift ? 'is-gift' : ''}`.trim()}
                  style={{ transform: `translateY(${(start + offset) * ROW}px)` }} title={`${message.user}：${message.text}`}>
                  <span className="msg-user">{message.user}</span>
                  <span className="msg-text">{message.text}</span>
                  {message.duplicateCount !== undefined && message.duplicateCount > 1 && (
                    <span className="msg-count num" title="相同弹幕的合并次数">×{message.duplicateCount}</span>
                  )}
                  {!message.gift && !message.huyaGift && (
                    <span className="msg-actions">
                      {!readOnly && message.platform !== 'huya' && <button type="button" className="msg-plus" disabled={!composer.canSendText(message.text)}
                        aria-label={`+1：${message.text}`} title={composer.repeatProblem(message.text) ?? '发送相同内容'}
                        onClick={() => void composer.repeat(message.text)}>+1</button>}
                      <button type="button" className="msg-more" aria-label={`更多操作：${message.text}`} title="更多操作"
                        onClick={() => { setRowNote(null); setRowMenu({ message, top: (start + offset + 1) * ROW - scrollTop }) }}>
                        <Icon name="more" />
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        {rowMenu && (
          <div className={`row-menu-anchor ${menuAbove ? 'is-above' : ''}`.trim()}
            style={{ top: menuAbove ? 8 : menuEdge, bottom: menuAbove ? Math.max(8, viewport - menuEdge) : 8 }}>
            <Popover open onClose={() => setRowMenu(null)} className="row-menu" label={`弹幕操作：${rowMenu.message.text}`}>
              <RowActions message={rowMenu.message} note={rowNote} setNote={setRowNote} close={() => setRowMenu(null)}
                onReply={() => { composer.reply(rowMenu.message.user); setRowMenu(null) }} />
            </Popover>
          </div>
        )}
        {unread > 0 && (
          <button type="button" className="drawer-jump" onClick={() => {
            const node = scroller.current
            if (!node) return
            pinned.current = true
            setUnread(0)
            node.scrollTop = node.scrollHeight
            placed.current = node.scrollTop
          }}>{unread > 99 ? '99+' : unread} 条新弹幕</button>
        )}
      </div>

      {!readOnly && <form className="say" onSubmit={(event) => { event.preventDefault(); if (!composing.current) void composer.sendDraft() }}>
        <textarea ref={box} rows={1} value={composer.draft} disabled={!composer.canEdit} aria-label="弹幕内容"
          placeholder={composer.canEdit ? '发送弹幕' : !composer.account?.loggedIn ? '登录斗鱼后可发送' : composer.needsRelogin ? '需要重新登录斗鱼' : danmaku.connected ? '正在准备…' : '连接弹幕后可发送'}
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
        <button type="submit" className="say-send" disabled={!!composer.blockedReason || !!composer.draftProblem}>发送</button>
        <p className="say-meta">
          {composer.needsRelogin
            ? <button type="button" className="link-btn" onClick={() => onOpenSettings('douyu')}>重新登录 {composer.account?.label}</button>
            : composer.account?.loggedIn
              ? <span>以 {composer.account.label} 发送</span>
              : <button type="button" className="link-btn" onClick={() => onOpenSettings('douyu')}>登录斗鱼</button>}
          {composer.remaining > 0 && <span className="num">{composer.remaining}s</span>}
          {composer.affixes.enabled && composer.draft.length > 0 && <span title="在弹幕设置中修改">含前后缀</span>}
          {composer.composedLength > composer.lengthLimit * 0.8 && <span className="num">{composer.composedLength}/{composer.lengthLimit}</span>}
        </p>
        {composer.draft.length > 0 && composer.draftProblem && <p className="say-note is-warn">{composer.draftProblem}</p>}
        {composer.needsRelogin && composer.blockedReason && <p className="say-note is-warn" role="status">{composer.blockedReason}</p>}
        {/* A send that cannot go out says why, instead of Enter silently doing nothing. */}
        {composer.draft.length > 0 && !composer.needsRelogin && !composer.draftProblem && !composer.notice && composer.blockedReason && composer.remaining === 0 && (
          <p className="say-note is-warn" role="status">{composer.blockedReason}</p>
        )}
        {composer.notice && <p className="say-note" data-state={composer.notice.status} role="status">{composer.notice.message}</p>}
        {deliveryText(composer.delivery) && <p className="say-note">{deliveryText(composer.delivery)}</p>}
      </form>}
    </aside>
  )
}

/** The actions behind a row's "更多操作": the same ones the hover menu over the picture offers. */
function RowActions({ message, note, setNote, close, onReply }: {
  message: DanmakuMessage
  note: string | null
  setNote: (note: string | null) => void
  close: () => void
  onReply: () => void
}): React.ReactNode {
  const composer = useComposer()
  const actions = useDanmakuActions()
  const { danmaku } = useSessionSnapshot()
  const readOnly = message.platform === 'huya' || danmaku.room?.startsWith('huya:') === true
  const uid = message.sender?.uid
  return (
    <>
      <span className="row-menu-user">{message.user}{uid && <span className="num muted"> {uid}</span>}</span>
      {!readOnly && <button type="button" className="menu-item" disabled={!composer.canEdit} onClick={onReply}>回复</button>}
      {!readOnly && <button type="button" className="menu-item" onClick={() => { void actions.favorite(message).then(setNote) }}>收藏</button>}
      <button type="button" className="menu-item" onClick={() => { actions.copy(message.text); close() }}>复制</button>
      {!readOnly && uid && actions.showDetails && (
        <button type="button" className="menu-item" onClick={() => { actions.showDetails?.(message); close() }}>用户详情</button>
      )}
      {!readOnly && uid && <button type="button" className="menu-item" onClick={() => { actions.history(uid); close() }}>历史弹幕</button>}
      {!readOnly && uid && <button type="button" className="menu-item" onClick={() => { actions.mute(message); close() }}>禁言</button>}
      <button type="button" className="menu-item is-danger" onClick={() => { actions.block(message.user); close() }}>屏蔽此用户</button>
      {note && <p className="lane" role="status">{note}</p>}
    </>
  )
}
