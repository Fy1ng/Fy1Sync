/**
 * Danmaku over the picture, with a menu on the one under the pointer.
 *
 * Motion follows the old player's overlay: each message's
 * speed is fixed when it spawns, lanes come from the allocator, and positions are written
 * straight to the DOM every frame. What this adds is hover: the message under the pointer
 * stops where it is and a small menu opens beneath it, the way it does on Douyu. Moving
 * off both the message and its menu lets it carry on from where it stopped.
 *
 * The layer itself never takes the pointer; only the moving text does, so the picture
 * underneath still gets clicks everywhere else.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAnimationFrame } from '../app/hooks'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { AREA_FRACTION, DanmakuLaneAllocator, estimateTextWidth } from '../core/danmakuLanes'
import { danmakuLaneHeight } from '../core/danmakuProcessing'
import type { DanmakuMessage } from '../core/danmakuTimeline'
import { useComposer } from './composer'
import { useDanmakuActions } from './danmakuActions'

interface ActiveItem {
  node: HTMLSpanElement
  message: DanmakuMessage
  /** Captured at spawn so a later speed change leaves this one alone. */
  pxPerSecond: number
  startMs: number
  fromX: number
  x: number
  top: number
  width: number
  /** Frame clock when the pointer stopped it; null while it moves. */
  heldAt: number | null
}

interface Menu { item: ActiveItem; left: number; top: number }

/** Grace period for crossing the gap between a message and its menu. */
const LEAVE_DELAY_MS = 220
const MENU_HEIGHT = 36

/** The "×N" a merged duplicate carries, or nothing for a single message. */
function countLabel(message: DanmakuMessage): string {
  return message.duplicateCount && message.duplicateCount > 1 ? `×${message.duplicateCount}` : ''
}

export function DanmakuStage({ onReply }: { onReply: () => void }): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const { danmaku } = snapshot.settings
  const composer = useComposer()
  const actions = useDanmakuActions()
  const [note, setNote] = useState<string | null>(null)
  const gapRef = useRef(snapshot.danmakuPreferences.verticalGapPx)
  gapRef.current = snapshot.danmakuPreferences.verticalGapPx

  const hostRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<ActiveItem[]>([])
  const sizeRef = useRef({ width: 0, height: 0 })
  const allocatorRef = useRef<DanmakuLaneAllocator | null>(null)
  const settingsRef = useRef(danmaku)
  settingsRef.current = danmaku
  const [menu, setMenu] = useState<Menu | null>(null)
  const menuRef = useRef<Menu | null>(null)
  menuRef.current = menu
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const layoutFor = useCallback(() => {
    const settings = settingsRef.current
    const { width, height } = sizeRef.current
    const laneHeight = danmakuLaneHeight(settings.fontSize, gapRef.current)
    return { laneHeight, areaHeight: Math.max(laneHeight, height * AREA_FRACTION[settings.area]), width, speed: settings.speed }
  }, [])

  const cancelLeave = (): void => {
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current)
    leaveTimer.current = null
  }

  /** Let the held message move again, from where it stopped. */
  const release = useCallback(() => {
    cancelLeave()
    const held = menuRef.current?.item
    if (held && held.heldAt !== null) {
      held.startMs += performance.now() - held.heldAt
      held.heldAt = null
      held.node.classList.remove('is-held')
    }
    setMenu(null)
    setNote(null)
  }, [])

  const scheduleLeave = (): void => {
    cancelLeave()
    leaveTimer.current = setTimeout(release, LEAVE_DELAY_MS)
  }

  const flush = useCallback(() => {
    for (const item of activeRef.current) item.node.remove()
    activeRef.current = []
    allocatorRef.current?.reset()
    cancelLeave()
    setMenu(null)
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = (): void => {
      sizeRef.current = { width: host.clientWidth, height: host.clientHeight }
      allocatorRef.current?.setLayout(layoutFor())
    }
    measure()
    allocatorRef.current ??= new DanmakuLaneAllocator(layoutFor())
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [layoutFor])

  useEffect(() => { allocatorRef.current?.setLayout(layoutFor()) },
    [danmaku.fontSize, danmaku.area, danmaku.speed, snapshot.danmakuPreferences.verticalGapPx, layoutFor])

  // "合并计数" raises the count of a message already on screen; follow it there.
  useEffect(() => session.subscribeChat(() => {
    const onScreen = new Map<string, ActiveItem>()
    for (const item of activeRef.current) if (item.message.duplicateGroupId) onScreen.set(item.message.duplicateGroupId, item)
    if (onScreen.size === 0) return
    const history = session.chatHistory()
    for (let i = history.length - 1, seen = 0; i >= 0 && seen < 300; i--, seen++) {
      const latest = history[i]!
      const item = latest.duplicateGroupId ? onScreen.get(latest.duplicateGroupId) : undefined
      if (!item || item.message.duplicateCount === latest.duplicateCount) continue
      item.message = latest
      const badge = item.node.querySelector('.danmaku-count')
      if (badge) badge.textContent = countLabel(latest)
      onScreen.delete(latest.duplicateGroupId!)
    }
  }), [session])
  useEffect(() => { if (!danmaku.enabled) flush() }, [danmaku.enabled, flush])
  useEffect(() => { flush() }, [snapshot.danmaku.room, flush])
  useEffect(() => flush, [flush])

  const spawn = useCallback((message: DanmakuMessage, nowMs: number): void => {
    const host = hostRef.current
    const allocator = allocatorRef.current
    const settings = settingsRef.current
    const { width } = sizeRef.current
    if (!host || !allocator || width === 0 || message.gift) return
    const textWidth = estimateTextWidth(message.text, settings.fontSize)
    const assignment = allocator.allocateScroll(nowMs / 1000, textWidth)
    // Every lane still busy. Dropping beats stacking one comment on another.
    if (!assignment) return

    const node = document.createElement('span')
    node.className = 'danmaku-item'
    node.textContent = message.text
    if (message.duplicateGroupId) {
      const badge = document.createElement('span')
      badge.className = 'danmaku-count'
      badge.textContent = countLabel(message)
      node.appendChild(badge)
    }
    node.style.fontSize = `${settings.fontSize}px`
    node.style.opacity = String(settings.opacity)
    if (message.color) node.style.color = message.color
    node.style.transform = `translate3d(${width}px, ${assignment.top}px, 0)`
    host.appendChild(node)
    activeRef.current.push({
      node, message, pxPerSecond: settings.speed, startMs: nowMs, fromX: width, x: width,
      top: assignment.top, width: textWidth, heldAt: null,
    })
  }, [])

  useAnimationFrame((nowMs) => {
    // Draining continues with the overlay off: the chat list reads the same releases.
    const released = session.drainDanmaku()
    if (!settingsRef.current.enabled) return
    for (const message of released) spawn(message, nowMs)

    const active = activeRef.current
    let write = 0
    for (const item of active) {
      if (item.heldAt === null) {
        item.x = item.fromX - ((nowMs - item.startMs) / 1000) * item.pxPerSecond
        if (item.x < -item.width) { item.node.remove(); continue }
        item.node.style.transform = `translate3d(${item.x}px, ${item.top}px, 0)`
      }
      active[write] = item
      write += 1
    }
    active.length = write
  })

  const itemAt = (target: EventTarget | null): ActiveItem | undefined => {
    const node = target instanceof Element ? target.closest('.danmaku-item') : null
    return node ? activeRef.current.find((item) => item.node === node) : undefined
  }

  const onPointerOver = (event: React.PointerEvent): void => {
    const item = itemAt(event.target)
    if (!item) return
    cancelLeave()
    if (menuRef.current?.item === item) return
    release()
    item.heldAt = performance.now()
    // On top, so later messages in the same lane pass beneath it instead of taking the pointer.
    item.node.classList.add('is-held')
    const { width, height } = sizeRef.current
    const lane = danmakuLaneHeight(settingsRef.current.fontSize, gapRef.current)
    const below = item.top + lane + 2
    setNote(null)
    setMenu({
      item,
      // Wide enough for the full row of actions; the menu itself never overflows the picture.
      left: Math.max(8, Math.min(item.x, width - 480)),
      top: below + MENU_HEIGHT > height - 8 ? Math.max(8, item.top - MENU_HEIGHT - 4) : below,
    })
  }

  const blockUser = (user: string): void => {
    actions.block(user)
    for (const item of activeRef.current) if (item.message.user === user) item.node.remove()
    activeRef.current = activeRef.current.filter((item) => item.message.user !== user)
  }

  const message = menu?.item.message
  const repeatProblem = message ? composer.repeatProblem(message.text) : null
  const uid = message?.sender?.uid

  return (
    <>
      <div className="danmaku-layer danmaku-stage" ref={hostRef} aria-hidden="true"
        onPointerOver={onPointerOver} onPointerOut={(event) => { if (itemAt(event.target)) scheduleLeave() }} />
      {menu && message && (
        <div className="dm-menu" role="toolbar" aria-label={`弹幕操作：${message.text}`}
          style={{ left: menu.left, top: menu.top }}
          onPointerEnter={cancelLeave} onPointerLeave={scheduleLeave}>
          <span className="dm-menu-user" title={message.user}>{message.user}</span>
          <button type="button" disabled={!!repeatProblem} title={repeatProblem ?? '发送相同内容'}
            onClick={() => { void composer.repeat(message.text); release() }}>+1</button>
          <button type="button" disabled={!composer.canEdit} title={composer.canEdit ? `回复 ${message.user}` : '连接弹幕并登录斗鱼后可回复'}
            onClick={() => { composer.reply(message.user); onReply(); release() }}>回复</button>
          <button type="button" title="收藏到本机"
            onClick={() => { void actions.favorite(message).then(setNote) }}>收藏</button>
          <button type="button" title="复制弹幕内容"
            onClick={() => { actions.copy(message.text); release() }}>复制</button>
          <button type="button" title={`不再显示 ${message.user} 的弹幕`}
            onClick={() => { blockUser(message.user); release() }}>屏蔽</button>
          {uid && actions.showDetails && (
            <button type="button" title="查看用户详情" onClick={() => { actions.showDetails?.(message); release() }}>详情</button>
          )}
          {uid && <button type="button" title="查询该用户的历史弹幕" onClick={() => { actions.history(uid); release() }}>历史</button>}
          {uid && <button type="button" title="在当前房间禁言该用户" onClick={() => { actions.mute(message); release() }}>禁言</button>}
          {note && <span className="dm-menu-note" role="status">{note}</span>}
        </div>
      )}
    </>
  )
}
