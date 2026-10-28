/**
 * Danmaku over the picture, with a menu on the one under the pointer.
 *
 * Motion, measuring and lanes live in `ScrollingLayer` (shared with the PiP window); this
 * file adds what only the main stage has: settings, merged counts and the hover menu.
 *
 * Hover stops the message under the pointer where it is and opens a small menu beneath
 * the pointer, the way it does on Douyu. Moving off both the message and its menu lets it
 * carry on from where it stopped.
 *
 * The layer itself never takes the pointer; only the moving text does, so the picture
 * underneath still gets clicks everywhere else.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAnimationFrame } from '../app/hooks'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { AREA_FRACTION } from '../core/danmakuLanes'
import { danmakuLaneHeight } from '../core/danmakuProcessing'
import type { DanmakuMessage } from '../core/danmakuTimeline'
import { useComposer } from './composer'
import { useDanmakuActions } from './danmakuActions'
import { ScrollingLayer, type LayerEntry, type LayerItem } from './danmakuLayer'

type ActiveItem = LayerItem<DanmakuMessage>

/** `x` is the pointer, where the menu wants to start; a layout effect keeps it inside. */
interface Menu { item: ActiveItem; x: number; top: number }

/** Grace period for crossing the gap between a message and its menu. */
const LEAVE_DELAY_MS = 220
const MENU_HEIGHT = 36
/** The menu starts a little left of the pointer, so the pointer lands on its first entries. */
const MENU_POINTER_INSET = 24
const MENU_MARGIN = 8

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
  const layerRef = useRef<ScrollingLayer<DanmakuMessage> | null>(null)
  const sizeRef = useRef({ width: 0, height: 0 })
  const settingsRef = useRef(danmaku)
  settingsRef.current = danmaku
  const [menu, setMenu] = useState<Menu | null>(null)
  const menuRef = useRef<Menu | null>(null)
  menuRef.current = menu
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const menuNode = useRef<HTMLDivElement | null>(null)

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
    if (held?.held) {
      layerRef.current?.resume(held)
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
    layerRef.current?.clear()
    cancelLeave()
    setMenu(null)
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = (): void => {
      sizeRef.current = { width: host.clientWidth, height: host.clientHeight }
      layerRef.current?.setLayout(layoutFor(), performance.now())
    }
    measure()
    layerRef.current ??= new ScrollingLayer(host, layoutFor())
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [layoutFor])

  useEffect(() => { layerRef.current?.setLayout(layoutFor(), performance.now()) },
    [danmaku.fontSize, danmaku.area, danmaku.speed, snapshot.danmakuPreferences.verticalGapPx, layoutFor])

  // "合并计数" raises the count of a message already on screen; follow it there.
  useEffect(() => session.subscribeChat(() => {
    const onScreen = new Map<string, ActiveItem>()
    for (const item of layerRef.current?.items ?? []) if (item.data.duplicateGroupId) onScreen.set(item.data.duplicateGroupId, item)
    if (onScreen.size === 0) return
    const history = session.chatHistory()
    for (let i = history.length - 1, seen = 0; i >= 0 && seen < 300; i--, seen++) {
      const latest = history[i]!
      const item = latest.duplicateGroupId ? onScreen.get(latest.duplicateGroupId) : undefined
      if (!item || item.data.duplicateCount === latest.duplicateCount) continue
      item.data = latest
      const badge = item.node.querySelector('.danmaku-count')
      if (badge) badge.textContent = countLabel(latest)
      layerRef.current?.refit(item)
      onScreen.delete(latest.duplicateGroupId!)
    }
  }), [session])
  useEffect(() => { if (!danmaku.enabled) flush() }, [danmaku.enabled, flush])
  useEffect(() => { flush() }, [snapshot.danmaku.room, flush])
  useEffect(() => flush, [flush])

  const entryFor = (message: DanmakuMessage): LayerEntry<DanmakuMessage> => {
    const settings = settingsRef.current
    return {
      data: message, text: message.text, fontSize: settings.fontSize,
      build: () => {
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
        return node
      },
    }
  }

  useAnimationFrame((nowMs) => {
    // Draining continues with the overlay off: the chat list reads the same releases.
    const released = session.drainDanmaku()
    const layer = layerRef.current
    if (!settingsRef.current.enabled || !layer) return
    const scrolling = released.filter((message) => !message.gift && !message.huyaGift)
    if (scrolling.length > 0) layer.spawn(scrolling.map(entryFor), nowMs)
    layer.sweep()
  })

  const itemAt = (target: EventTarget | null): ActiveItem | undefined => {
    const node = target instanceof Element ? target.closest('.danmaku-item') : null
    return node ? layerRef.current?.itemFor(node) : undefined
  }

  const pointerX = (event: React.PointerEvent): number =>
    event.clientX - (hostRef.current?.getBoundingClientRect().left ?? 0)

  const onPointerOver = (event: React.PointerEvent): void => {
    const item = itemAt(event.target)
    if (!item) return
    cancelLeave()
    if (menuRef.current?.item === item) return
    release()
    layerRef.current?.hold(item)
    // On top, so later messages in the same lane pass beneath it instead of taking the pointer.
    item.node.classList.add('is-held')
    const { height } = sizeRef.current
    const lane = danmakuLaneHeight(settingsRef.current.fontSize, gapRef.current)
    const below = item.top + lane + 2
    setNote(null)
    setMenu({
      item,
      x: pointerX(event),
      top: below + MENU_HEIGHT > height - MENU_MARGIN ? Math.max(MENU_MARGIN, item.top - MENU_HEIGHT - 4) : below,
    })
  }

  // Along a long message the menu stays under the pointer.
  const onPointerMove = (event: React.PointerEvent): void => {
    const current = menuRef.current
    if (!current || itemAt(event.target) !== current.item) return
    const x = pointerX(event)
    if (Math.abs(x - current.x) >= 1) setMenu({ ...current, x })
  }

  // The menu's width depends on which actions this room allows; measure it to keep it inside.
  useLayoutEffect(() => {
    const node = menuNode.current
    if (!node || !menu) return
    const room = sizeRef.current.width - node.offsetWidth - MENU_MARGIN
    node.style.left = `${Math.max(MENU_MARGIN, Math.min(menu.x - MENU_POINTER_INSET, room))}px`
  }, [menu, note])

  const blockUser = (user: string): void => {
    actions.block(user)
    layerRef.current?.remove((item) => item.data.user === user)
  }

  const message = menu?.item.data
  const readOnly = message?.platform === 'huya' || snapshot.danmaku.room?.startsWith('huya:') === true
  const writes = snapshot.settings.douyuWrites
  const repeatProblem = message ? composer.repeatProblem(message.text) : null
  const uid = message?.sender?.uid

  return (
    <>
      <div className="danmaku-layer danmaku-stage" ref={hostRef} aria-hidden="true"
        onPointerOver={onPointerOver} onPointerMove={onPointerMove} onPointerOut={(event) => { if (itemAt(event.target)) scheduleLeave() }} />
      {menu && message && (
        <div ref={menuNode} className="dm-menu" role="toolbar" aria-label={`弹幕操作：${message.text}`}
          style={{ top: menu.top }}
          onPointerEnter={cancelLeave} onPointerLeave={scheduleLeave}>
          <span className="dm-menu-user" title={message.user}>{message.user}</span>
          {writes && !readOnly && <button type="button" disabled={!!repeatProblem} title={repeatProblem ?? '发送相同内容'}
            onClick={() => { void composer.repeat(message.text); release() }}>+1</button>}
          {writes && !readOnly && <button type="button" disabled={!composer.canEdit} title={composer.canEdit ? `回复 ${message.user}` : '连接弹幕并登录斗鱼后可回复'}
            onClick={() => { composer.reply(message.user); onReply(); release() }}>回复</button>}
          {!readOnly && <button type="button" title="收藏到本机"
            onClick={() => { void actions.favorite(message).then(setNote) }}>收藏</button>}
          <button type="button" title="复制弹幕内容"
            onClick={() => { actions.copy(message.text); release() }}>复制</button>
          <button type="button" title={`不再显示 ${message.user} 的弹幕`}
            onClick={() => { blockUser(message.user); release() }}>屏蔽</button>
          {!readOnly && uid && actions.showDetails && (
            <button type="button" title="查看用户详情" onClick={() => { actions.showDetails?.(message); release() }}>详情</button>
          )}
          {!readOnly && uid && <button type="button" title="查询该用户的历史弹幕" onClick={() => { actions.history(uid); release() }}>历史</button>}
          {writes && !readOnly && uid && <button type="button" title="在当前房间禁言该用户" onClick={() => { actions.mute(message); release() }}>禁言</button>}
          {note && <span className="dm-menu-note" role="status">{note}</span>}
        </div>
      )}
    </>
  )
}
