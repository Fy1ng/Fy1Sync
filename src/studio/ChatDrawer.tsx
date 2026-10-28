/**
 * The room's chat, released in step with the voice, and a line to send into it.
 *
 * Windowed with TanStack Virtual: a busy room releases hundreds of messages a minute and
 * only the visible rows are in the DOM. Rows wrap, so each is measured as it renders. The
 * list is anchored to its end: it follows new messages while at the bottom, and once the
 * reader scrolls up it holds the row they are reading still, also while the oldest
 * messages are dropped from the front. A way back down is offered meanwhile.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import type { DanmakuMessage } from '../core/danmakuTimeline'
import { useComposer } from './composer'
import { useDouyuWrites } from './douyuWrites'
import { useDanmakuActions } from './danmakuActions'
import { useDanmakuRate } from './insights/RoomInsights'
import type { RecordsTab } from './records/DanmakuRecords'
import type { SettingsSection } from './SettingsSheet'
import { Icon, Popover } from './kit'
import { useSourceLoader } from './sources'
import { deliveryText } from './useStudioComposer'
import { remember } from '../app/remembered'

/** A one-line row; longer messages wrap and are measured. */
const ROW = 30
/** How close to the end still counts as following it. */
const END_SLACK = ROW

export function ChatDrawer({ onClose, onOpenSettings, onOpenRecords }: {
  onClose: () => void
  onOpenSettings: (section?: SettingsSection) => void
  onOpenRecords: (tab: RecordsTab, uid?: string) => void
}): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const { danmaku } = snapshot
  const readOnly = danmaku.room?.startsWith('huya:') === true
  const writes = useDouyuWrites()
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
  const [viewport, setViewport] = useState(0)
  const seen = useRef(total)
  const [unread, setUnread] = useState(0)
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    getItemKey: (index) => messages[index]!.id,
    overscan: 6,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: END_SLACK,
    initialOffset: () => Number.MAX_SAFE_INTEGER,
  })
  const atEnd = useRef(true)

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
    const arrived = Math.max(0, total - seen.current)
    seen.current = total
    if (!atEnd.current && arrived > 0) setUnread((count) => count + arrived)
    if (messages.length === 0) setUnread(0)
  }, [total, messages.length])

  // A smaller viewport (the window, or the send box growing) keeps a followed list at the end.
  useLayoutEffect(() => {
    if (atEnd.current && messages.length > 0) virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })
  }, [viewport])

  // "回复" from the picture writes into the box; follow it there.
  useEffect(() => {
    if (composer.focusRequest === 0) return
    const node = box.current
    if (!node) return
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
  }, [composer.focusRequest])

  const rows = virtualizer.getVirtualItems()
  const scrollTop = virtualizer.scrollOffset ?? 0
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
          <button type="button" className="icon-btn" onClick={() => onOpenSettings()} aria-label="设置" title="设置">
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
            // Read the element itself: the virtualizer's own scroll listener may not have run yet.
            const node = event.currentTarget
            atEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight <= END_SLACK
            if (atEnd.current) setUnread(0)
            setRowMenu(null)
          }}>
          {messages.length === 0 ? (
            <p className="drawer-empty">
              {danmaku.connected ? '弹幕将随解说进度显示' : danmaku.room ? '正在连接…' : '载入斗鱼或虎牙解说后显示弹幕'}
            </p>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {rows.map((row) => { const message = messages[row.index]!; return (
                <div key={row.key} data-index={row.index} ref={virtualizer.measureElement}
                  className={`msg ${message.gift || message.huyaGift ? 'is-gift' : ''}`.trim()}
                  style={{ transform: `translateY(${row.start}px)` }}>
                  <span className="msg-user">{message.user}</span>
                  <span className="msg-text">{message.text}</span>
                  {message.duplicateCount !== undefined && message.duplicateCount > 1 && (
                    <span className="msg-count num" title="相同弹幕的合并次数">×{message.duplicateCount}</span>
                  )}
                  {!message.gift && !message.huyaGift && (
                    <span className="msg-actions">
                      {writes && !readOnly && message.platform !== 'huya' && <button type="button" className="msg-plus" disabled={!composer.canSendText(message.text)}
                        aria-label={`+1：${message.text}`} title={composer.repeatProblem(message.text) ?? '发送相同内容'}
                        onClick={() => void composer.repeat(message.text)}>+1</button>}
                      <button type="button" className="msg-more" aria-label={`更多操作：${message.text}`} title="更多操作"
                        onClick={() => { setRowNote(null); setRowMenu({ message, top: row.end - scrollTop }) }}>
                        <Icon name="more" />
                      </button>
                    </span>
                  )}
                </div>
              ) })}
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
            atEnd.current = true
            setUnread(0)
            if (messages.length > 0) virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })
          }}>{unread > 99 ? '99+' : unread} 条新弹幕</button>
        )}
      </div>

      {writes && !readOnly && <form className="say" onSubmit={(event) => { event.preventDefault(); if (!composing.current) void composer.sendDraft() }}>
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
            ? <button type="button" className="link-btn" onClick={() => { remember('douyu:tab', 'accounts'); onOpenSettings('douyu') }}>重新登录 {composer.account?.label}</button>
            : composer.account?.loggedIn
              ? <span>以 {composer.account.label} 发送</span>
              : <button type="button" className="link-btn" onClick={() => { remember('douyu:tab', 'accounts'); onOpenSettings('douyu') }}>登录斗鱼</button>}
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
  const writes = useDouyuWrites()
  const uid = message.sender?.uid
  return (
    <>
      <span className="row-menu-user">{message.user}{uid && <span className="num muted"> {uid}</span>}</span>
      {writes && !readOnly && <button type="button" className="menu-item" disabled={!composer.canEdit} onClick={onReply}>回复</button>}
      {!readOnly && <button type="button" className="menu-item" onClick={() => { void actions.favorite(message).then(setNote) }}>收藏</button>}
      <button type="button" className="menu-item" onClick={() => { actions.copy(message.text); close() }}>复制</button>
      {!readOnly && uid && actions.showDetails && (
        <button type="button" className="menu-item" onClick={() => { actions.showDetails?.(message); close() }}>用户详情</button>
      )}
      {!readOnly && uid && <button type="button" className="menu-item" onClick={() => { actions.history(uid); close() }}>历史弹幕</button>}
      {writes && !readOnly && uid && <button type="button" className="menu-item" onClick={() => { actions.mute(message); close() }}>禁言</button>}
      <button type="button" className="menu-item is-danger" onClick={() => { actions.block(message.user); close() }}>屏蔽此用户</button>
      {note && <p className="lane" role="status">{note}</p>}
    </>
  )
}
