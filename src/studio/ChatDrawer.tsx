/**
 * The room's chat, released in step with the voice, and a line to send into it.
 *
 * Windowed with TanStack Virtual: a busy room releases hundreds of messages a minute and
 * only the visible rows are in the DOM. Rows wrap, so each is measured as it renders. The
 * list is anchored to its end: it follows new messages while at the bottom, and once the
 * reader scrolls up it holds the row they are reading still, also while the oldest
 * messages are dropped from the front. A way back down is offered meanwhile.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ErrorDetailsButton, ErrorText } from '../ui/ErrorDetails'
import type { DisplayError } from '../core/errorDetails'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { shortcutTitle } from '../app/shortcuts'
import type { DanmakuMessage } from '../core/danmakuTimeline'
import { useComposer } from './composer'
import { useDouyuWrites } from './douyuWrites'
import { useDanmakuActions } from './danmakuActions'
import { useDanmakuRate } from './insights/RoomInsights'
import type { RecordsTab } from './records/DanmakuRecords'
import type { SettingsSection, SettingsTarget } from './SettingsSheet'
import { Icon, Popover } from './kit'
import { useSourceLoader } from './sources'
import { deliveryText } from './useStudioComposer'
import { remember } from '../app/remembered'
import { useChatFollow } from './useChatFollow'
import { DouyinComposer } from './DouyinComposer'
import { isReadOnlyDanmakuPlatform, isReadOnlyDanmakuRoom } from '../../server/danmaku/types'
import { DouyuLotteryCard, DouyuLotteryCommandGroup, type DouyuLotteryView } from './douyu/douyuLottery'
import { BilibiliGiftLabel, BilibiliMessage, BilibiliSenderBadges, BilibiliSuperChatFeed } from './BilibiliMessage'
import { DouyinDanmakuIdentity, DouyinDanmakuText } from './DouyinDanmakuContent'
import { huyaChatColorHex } from '../core/huyaChat'
import type { SourceRole } from '../core/types'
import { BilibiliEmoteDirectory, RestrictedChatStatus } from './insights/PlatformRoomInsights'

/** A one-line row; longer messages wrap and are measured. */
const ROW = 30

export function ChatDrawer({ onClose, onOpenSettings, onOpenRecords, douyuLottery, platformActivities, restrictedChatSources = [] }: {
  onClose: () => void
  onOpenSettings: (section?: SettingsSection, account?: SettingsTarget['account']) => void
  onOpenRecords: (tab: RecordsTab, uid?: string) => void
  douyuLottery?: DouyuLotteryView
  platformActivities?: React.ReactNode
  restrictedChatSources?: SourceRole[]
}): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const { danmaku } = snapshot
  const connectionFailure = danmaku as typeof danmaku & { errorDetail?: unknown; detail?: unknown }
  const readOnly = isReadOnlyDanmakuRoom(danmaku.room) || (!danmaku.room && restrictedChatSources.length > 0)
  const writes = useDouyuWrites()
  const composer = useComposer()
  const delivery = deliveryText(composer.delivery)
  const { roomName } = useSourceLoader()
  const rate = useDanmakuRate(readOnly ? null : danmaku.room)
  // One menu for the whole list, anchored to the button it was opened from.
  const [rowMenu, setRowMenu] = useState<{ message: DanmakuMessage; anchor: HTMLElement } | null>(null)
  const rowMenuRef = useRef(rowMenu)
  rowMenuRef.current = rowMenu
  const [rowNote, setRowNote] = useState<string | DisplayError | null>(null)
  const box = useRef<HTMLTextAreaElement | null>(null)
  const subscribe = useCallback((listener: () => void) => session.subscribeChat(listener), [session])
  const messages = useSyncExternalStore(subscribe, () => session.chatHistory())
  const entries = useMemo(() => {
    const result: { messages: DanmakuMessage[]; activityKey: string | null }[] = []
    for (const message of messages) {
      const activityKey = message.platformActivityKey ?? (message.douyuLotteryActivityId && message.room ? `${message.room}:${message.douyuLotteryActivityId}` : null)
      const previous = result.at(-1)
      if (previous && activityKey && previous.activityKey === activityKey) previous.messages.push(message)
      else result.push({ messages: [message], activityKey })
    }
    return result
  }, [messages])
  const total = useSyncExternalStore(subscribe, () => session.chatCount())

  const scroller = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    getItemKey: (index) => entries[index]!.messages[0]!.id,
    overscan: 6,
    anchorTo: 'end',
    // Reading anchors still belong to the virtualizer; explicit follow intent handles the end.
    followOnAppend: false,
    scrollEndThreshold: 1,
    // Start at the end, but as a real offset. A sentinel like MAX_SAFE_INTEGER is never read back
    // while the list is too short to scroll, since no scroll event fires, so the virtualizer
    // went on computing the visible range from that far-off offset. It kept only the newest row
    // plus overscan, and the rows above went missing while the list was still filling up.
    initialOffset: () => Math.max(0, entries.length * ROW - (scroller.current?.clientHeight ?? 0)),
  })
  const { unread, jump, onScroll } = useChatFollow(scroller, virtualizer, total, entries.length, danmaku.room)

  // "回复" from the picture writes into the box; follow it there.
  useEffect(() => {
    if (composer.focusRequest === 0) return
    const node = box.current
    if (!node) return
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
  }, [composer.focusRequest])

  const rows = virtualizer.getVirtualItems()
  const composing = useRef(false)
  const rowContents = (message: DanmakuMessage) => <>
    <span className="msg-user">{message.user}</span>
    <span className="msg-text" style={message.huyaChat ? { color: huyaChatColorHex(message.huyaChat.textColor) } : undefined}>
      {message.platform === 'bilibili' ? <>
        <BilibiliSenderBadges sender={message.bilibiliSender} />{' '}
        {message.bilibiliGift ? <BilibiliGiftLabel gift={message.bilibiliGift} /> : <BilibiliMessage {...message} />}
      </> : message.platform === 'douyin' ? <>
        <DouyinDanmakuIdentity douyin={message.douyin} />{' '}
        <DouyinDanmakuText text={message.text} douyin={message.douyin} />
      </> : <>
        {message.huyaChat?.kind === 'on-tv-barrage' && <small>上电视 </small>}
        {message.huyaChat?.sender?.fansBadge?.name && <small>{message.huyaChat.sender.fansBadge.name} </small>}
        {message.text}
      </>}
    </span>
    {message.duplicateCount !== undefined && message.duplicateCount > 1 && (
      <span className="msg-count num" title="相同弹幕的合并次数">×{message.duplicateCount}</span>
    )}
    {!message.system && !message.gift && !message.huyaGift && !message.bilibiliGift && (
      <span className="msg-actions">
        {writes && !readOnly && !isReadOnlyDanmakuPlatform(message.platform) && <button type="button" className="msg-plus" disabled={!composer.canSendText(message.text)}
          aria-label={`+1：${message.text}`} title={composer.repeatProblem(message.text) ?? '发送相同内容'}
          onClick={() => void composer.repeat(message.text)}>+1</button>}
        <button type="button" className="msg-more" aria-label={`更多操作：${message.text}`} title="更多操作"
          onClick={(event) => { setRowNote(null); const next = { message, anchor: event.currentTarget }; rowMenuRef.current = next; setRowMenu(next) }}>
          <Icon name="more" />
        </button>
      </span>
    )}
  </>

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
          {(danmaku.room || restrictedChatSources.length > 0) && (
            <button type="button" className="icon-btn" onClick={() => onOpenSettings('insights')} aria-label="房间数据" title="房间数据">
              <Icon name="stats" />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={() => onOpenSettings()} aria-label="设置" title="设置">
            <Icon name="gear" />
          </button>
        </span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="收起弹幕" title={shortcutTitle('收起', snapshot.settings.shortcuts.toggleSidebar)}>
          <Icon name="close" />
        </button>
      </header>

      {douyuLottery && <DouyuLotteryCard view={douyuLottery} />}
      {platformActivities}
      {danmaku.room?.startsWith('bilibili:') && <>
        <BilibiliEmoteDirectory key={danmaku.room} room={danmaku.room} />
        {danmaku.bilibiliSuperChats && <BilibiliSuperChatFeed room={danmaku.room} state={danmaku.bilibiliSuperChats} />}
      </>}
      {restrictedChatSources.map(role => <RestrictedChatStatus key={role} role={role} />)}

      <div className="drawer-feed">
        <div className="drawer-scroll" ref={scroller} role="log" aria-live="off" aria-label="弹幕列表" tabIndex={0}
          onScroll={() => {
            onScroll()
            rowMenuRef.current = null; setRowMenu(null)
          }}>
          {messages.length === 0 ? (
            <p className="drawer-empty">
              {danmaku.connected ? '已连接，暂无弹幕' : danmaku.room ? danmaku.error ? <ErrorText error={connectionFailure.errorDetail ?? connectionFailure.detail ?? { message: danmaku.error }} message={danmaku.error} /> : '正在连接…' : restrictedChatSources.length > 0 ? null : '载入直播间后显示弹幕'}
            </p>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {rows.map((row) => {
                const entry = entries[row.index]!
                const message = entry.messages[0]!
                const position = { transform: `translateY(${row.start}px)` }
                return entry.activityKey
                  ? <div key={row.key} data-index={row.index} ref={virtualizer.measureElement} className="msg-group" style={position}>
                    <DouyuLotteryCommandGroup count={entry.messages.length}>
                      {entry.messages.map(item => <div className="msg" key={item.id}>{rowContents(item)}</div>)}
                    </DouyuLotteryCommandGroup>
                  </div>
                  : <div key={row.key} data-index={row.index} ref={virtualizer.measureElement}
                    className={`msg ${message.gift || message.huyaGift ? 'is-gift' : ''}`.trim()} style={position}>{rowContents(message)}</div>
              })}
            </div>
          )}
        </div>
        {rowMenu && (
          <Popover key={rowMenu.message.id} open anchor={rowMenu.anchor} onClose={() => { rowMenuRef.current = null; setRowMenu(null) }} className="row-menu" label={`弹幕操作：${rowMenu.message.text}`}>
            <RowActions message={rowMenu.message} note={rowNote} setNote={note => { if (rowMenuRef.current === rowMenu) setRowNote(note) }} close={() => { rowMenuRef.current = null; setRowMenu(null) }}
              onReply={() => { composer.reply(rowMenu.message.user); rowMenuRef.current = null; setRowMenu(null) }} />
          </Popover>
        )}
        {unread > 0 && (
          <button type="button" className="drawer-jump" onClick={jump}>{unread > 99 ? '99+' : unread} 条新弹幕</button>
        )}
      </div>

      {danmaku.room?.startsWith('douyin:') && <DouyinComposer key={danmaku.room} room={danmaku.room} connected={danmaku.connected}
        onLogin={() => onOpenSettings('accounts', 'douyin')} />}
      {writes && !readOnly && <form className="say" onSubmit={(event) => { event.preventDefault(); if (!composing.current) void composer.sendDraft() }}>
        <textarea ref={box} rows={1} value={composer.draft} disabled={!composer.canEdit} aria-label="弹幕内容"
          placeholder={composer.canEdit ? '发送弹幕' : '弹幕内容'}
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
            ? <button type="button" className="link-btn" onClick={() => { remember('douyu:tab', 'accounts'); onOpenSettings('accounts', 'douyu') }}>重新登录 {composer.account?.label}</button>
            : composer.account?.loggedIn
              ? <span>以 {composer.account.label} 发送</span>
              : <button type="button" className="link-btn" onClick={() => { remember('douyu:tab', 'accounts'); onOpenSettings('accounts', 'douyu') }}>登录斗鱼</button>}
          {composer.remaining > 0 && <span className="num">{composer.remaining}s</span>}
          {composer.affixes.enabled && composer.draft.length > 0 && <span title="在弹幕设置中修改">含前后缀</span>}
          {composer.composedLength > composer.lengthLimit * 0.8 && <span className="num">{composer.composedLength}/{composer.lengthLimit}</span>}
        </p>
        {composer.draft.length > 0 && composer.draftProblem && <p className="say-note is-warn"><ErrorText error={composer.draftErrorDetail ?? composer.draftProblem} message={composer.draftProblem} /></p>}
        {composer.needsRelogin && composer.blockedReason && <p className="say-note is-warn" role="status"><ErrorText error={composer.blockedDetail ?? composer.blockedReason} message={composer.blockedReason} /></p>}
        {/* A send that cannot go out says why, instead of Enter silently doing nothing. */}
        {composer.draft.length > 0 && !composer.needsRelogin && !composer.draftProblem && !composer.notice && composer.blockedReason && composer.remaining === 0 && (
          <p className="say-note is-warn" role="status">{composer.blockedDetail ? <ErrorText error={composer.blockedDetail} message={composer.blockedReason} /> : composer.blockedReason}</p>
        )}
        {composer.notice && <p className="say-note" data-state={composer.notice.status} role="status">{composer.notice.status === 'succeeded' ? composer.notice.message : <ErrorText error={composer.notice.detail ?? composer.notice.message} message={composer.notice.message} />}</p>}
        {composer.configurationError && <p className="say-note is-warn" role="alert"><ErrorText error={composer.configurationDetail ?? composer.configurationError} message={composer.configurationError} /></p>}
        {composer.deliveryError && <p className="say-note is-warn" role="alert"><ErrorText error={composer.deliveryErrorDetail ?? composer.deliveryError} message={composer.deliveryError} /></p>}
        {delivery && !(composer.notice?.status === 'succeeded' && delivery === composer.notice.message) && <p className="say-note">{delivery}{composer.delivery && (composer.delivery.gateway === 'rejected' || composer.delivery.gateway === 'unknown' || composer.delivery.roomEcho === 'not-observed') && <ErrorDetailsButton error={composer.delivery} />}</p>}
      </form>}
    </aside>
  )
}

/** The actions behind a row's "更多操作": the same ones the hover menu over the picture offers. */
function RowActions({ message, note, setNote, close, onReply }: {
  message: DanmakuMessage
  note: string | DisplayError | null
  setNote: (note: string | DisplayError | null) => void
  close: () => void
  onReply: () => void
}): React.ReactNode {
  const composer = useComposer()
  const actions = useDanmakuActions()
  const { danmaku } = useSessionSnapshot()
  const readOnly = isReadOnlyDanmakuPlatform(message.platform) || isReadOnlyDanmakuRoom(danmaku.room)
  const writes = useDouyuWrites()
  const uid = message.sender?.uid
  const favoriteRevision = useRef(0)
  return (
    <>
      <span className="row-menu-user">{message.user}{!readOnly && uid && <span className="num muted"> {uid}</span>}</span>
      {writes && !readOnly && <button type="button" className="menu-item" disabled={!composer.canEdit} onClick={onReply}>回复</button>}
      {!readOnly && <button type="button" className="menu-item" onClick={() => { const mine = ++favoriteRevision.current; void actions.favorite(message).then(note => { if (mine === favoriteRevision.current) setNote(note) }) }}>收藏</button>}
      <button type="button" className="menu-item" disabled={actions.copying} onClick={() => { void actions.copy(message.text); close() }}>复制</button>
      {!readOnly && uid && actions.showDetails && (
        <button type="button" className="menu-item" onClick={() => { actions.showDetails?.(message); close() }}>用户详情</button>
      )}
      {!readOnly && uid && <button type="button" className="menu-item" onClick={() => { actions.history(uid); close() }}>历史弹幕</button>}
      {writes && !readOnly && uid && <button type="button" className="menu-item" onClick={() => { actions.mute(message); close() }}>禁言</button>}
      <button type="button" className="menu-item is-danger" onClick={() => { actions.block(message.user); close() }}>屏蔽此用户</button>
      {note && <p className="lane" role="status">{typeof note === 'string' ? note : <ErrorText error={note.detail ?? note} message={note.message} />}</p>}
    </>
  )
}
