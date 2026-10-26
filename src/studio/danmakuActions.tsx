/**
 * What can be done with one danmaku, wherever it is shown: over the picture or in the list.
 *
 * Both places offer the same actions, so they share this provider. It owns the two dialogs
 * that need more than a click — the sender's details and muting them — and renders them
 * once, outside whichever menu opened them (those menus close as soon as they are left).
 *
 * Nothing here sends a danmaku. Muting is a moderator action on the real room: it is
 * checked with the platform first and confirmed by the viewer before it is submitted.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { apiClient } from '../app/apiClient'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import type { DanmakuMessage } from '../core/danmakuTimeline'
import type { DouyuModerationOutcome, DouyuModerationPermission } from '../../server/douyu/moderation'
import { useComposer } from './composer'
import { Sheet } from './kit'
import type { RecordsTab } from './records/DanmakuRecords'

/**
 * The mute durations the backend accepts (`DOUYU_MUTE_MINUTES` in server/douyu/moderation.ts).
 * Copied, not imported: that module pulls the main process's network stack into the page.
 * A test keeps the two lists equal; the backend validates the value either way.
 */
export const MUTE_MINUTES = [1, 10, 30, 60, 480, 1440, 4320, 10080, 43200, 259200, 518400] as const

interface Actions {
  /** Save to the local favorites. Resolves to a short result line. */
  favorite: (message: DanmakuMessage) => Promise<string>
  copy: (text: string) => void
  /** Stop showing this sender's danmaku (local filter). */
  block: (user: string) => void
  /** Sender details; only when the "用户详情" switch is on and the sender has a UID. */
  showDetails: ((message: DanmakuMessage) => void) | null
  /** Mute in the real room, after a permission check and confirmation. Needs a UID. */
  mute: (message: DanmakuMessage) => void
  history: (uid: string) => void
}

const ActionsContext = createContext<Actions | null>(null)

export function DanmakuActionsProvider({ children, onOpenRecords }: {
  children: React.ReactNode
  onOpenRecords: (tab: RecordsTab, uid?: string) => void
}): React.ReactNode {
  const session = useSession()
  const { danmaku, danmakuPreferences } = useSessionSnapshot()
  const [details, setDetails] = useState<DanmakuMessage | null>(null)
  const [muting, setMuting] = useState<DanmakuMessage | null>(null)
  const room = danmaku.room

  const favorite = useCallback(async (message: DanmakuMessage): Promise<string> => {
    const uid = message.sender?.uid
    const result = await apiClient.feature('addDanmakuFavorite', {
      text: message.text, username: message.user, ...(room ? { room } : {}), ...(uid ? { uid } : {}),
    })
    return result.ok ? '已收藏' : result.message
  }, [room])

  const copy = useCallback((text: string) => { void navigator.clipboard?.writeText(text) }, [])

  const block = useCallback((user: string) => {
    const filter = session.settings.danmaku.filter
    if (filter.blockedUsers.includes(user)) return
    session.updateDanmakuSettings({ filter: { ...filter, blockedUsers: [...filter.blockedUsers, user] } })
  }, [session])

  const value = useMemo<Actions>(() => ({
    favorite, copy, block,
    showDetails: danmakuPreferences.showUserDetails ? (message) => setDetails(message) : null,
    mute: (message) => setMuting(message),
    history: (uid) => onOpenRecords('history', uid),
  }), [block, copy, danmakuPreferences.showUserDetails, favorite, onOpenRecords])

  return (
    <ActionsContext.Provider value={value}>
      {children}
      {details && room && details.sender?.uid && (
        <SenderDetails room={room} uid={details.sender.uid} name={details.user} onClose={() => setDetails(null)} />
      )}
      {muting && room && <MuteDialog room={room} message={muting} onClose={() => setMuting(null)} />}
    </ActionsContext.Provider>
  )
}

export function useDanmakuActions(): Actions {
  const actions = useContext(ActionsContext)
  if (!actions) throw new Error('useDanmakuActions outside DanmakuActionsProvider')
  return actions
}

type Details = { username?: string; observedAt?: number; level?: number; nobleLevel?: number; fansBadge?: { room: string; name: string; level: number } }

/** Only facts the room actually sent with this sender's messages; the rest is 未知. */
function SenderDetails({ room, uid, name, onClose }: { room: string; uid: string; name: string; onClose: () => void }): React.ReactNode {
  const [state, setState] = useState<{ details: Details | null; error: string | null } | null>(null)
  useEffect(() => {
    let live = true
    void apiClient.feature('getDanmakuUserDetails', { room, uid }).then((result) => {
      if (!live) return
      setState(result.ok ? { details: result.value as Details | null, error: null } : { details: null, error: result.message })
    })
    return () => { live = false }
  }, [room, uid])
  const d = state?.details
  const unknown = <span className="muted">未知</span>
  return (
    <Sheet title="用户详情" onClose={onClose}>
      <div className="sheet-body">
        {state === null ? <p className="muted">读取中…</p> : state.error ? <p className="form-error" role="alert">{state.error}</p> : (
          <dl className="facts">
            <dt>昵称</dt><dd>{d?.username ?? name}</dd>
            <dt>UID</dt><dd className="num">{uid}</dd>
            <dt>等级</dt><dd className="num">{d?.level ?? unknown}</dd>
            <dt>贵族</dt><dd className="num">{d?.nobleLevel ? d.nobleLevel : d ? '无' : unknown}</dd>
            <dt>粉丝牌</dt><dd>{d?.fansBadge ? <>{d.fansBadge.name} <span className="num">Lv.{d.fansBadge.level}</span>（房间 {d.fansBadge.room}）</> : unknown}</dd>
          </dl>
        )}
        <p className="muted">仅显示本机收到的该用户弹幕中携带的公开信息。</p>
      </div>
    </Sheet>
  )
}

const MINUTE_LABEL = (minutes: number): string =>
  minutes < 60 ? `${minutes} 分钟` : minutes < 1440 ? `${minutes / 60} 小时` : `${minutes / 1440} 天`

function MuteDialog({ room, message, onClose }: { room: string; message: DanmakuMessage; onClose: () => void }): React.ReactNode {
  const composer = useComposer()
  const account = composer.account
  const [minutes, setMinutes] = useState<number>(10)
  const [permission, setPermission] = useState<DouyuModerationPermission | null>(null)
  const [outcome, setOutcome] = useState<DouyuModerationOutcome | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!account?.loggedIn) return
    let live = true
    void apiClient.feature('previewDouyuMute', { accountId: account.id, room }).then((result) => {
      if (live) setPermission(result.ok ? result.value : { allowed: false, code: 'request-failed', message: result.message })
    })
    return () => { live = false }
  }, [account?.id, account?.loggedIn, room])

  const submit = async (): Promise<void> => {
    if (!account || busy || outcome) return
    setBusy(true)
    const result = await apiClient.feature('muteDouyuUser', { accountId: account.id, room, username: message.user, minutes })
    setOutcome(result.ok ? result.value : { status: 'failed', code: 'request-failed', message: result.message, submitted: false })
    setBusy(false)
  }

  return (
    <Sheet title="禁言" onClose={onClose}>
      <div className="sheet-body">
        <dl className="facts">
          <dt>房间</dt><dd className="num">{room}</dd>
          <dt>账号</dt><dd>{account?.label ?? '未设置'}</dd>
          <dt>用户</dt><dd>{message.user}</dd>
        </dl>
        {!account?.loggedIn ? <p className="form-error">请先登录斗鱼账号并设为当前账号。</p>
          : permission === null ? <p className="muted">正在向斗鱼确认管理权限…</p>
            : !permission.allowed ? <p className="form-error" role="alert">{permission.message}</p> : (
              <>
                <label className="field-row">
                  <span>时长</span>
                  <select value={minutes} disabled={busy || !!outcome} aria-label="禁言时长"
                    onChange={(event) => setMinutes(Number(event.target.value))}>
                    {MUTE_MINUTES.map((value) => <option key={value} value={value}>{MINUTE_LABEL(value)}</option>)}
                  </select>
                </label>
                {!outcome && (
                  <button type="button" className="btn-solid is-danger" disabled={busy} onClick={() => void submit()}>
                    {busy ? '正在提交…' : `确认禁言 ${MINUTE_LABEL(minutes)}`}
                  </button>
                )}
              </>
            )}
        {outcome && <p className={outcome.status === 'succeeded' ? 'lane' : 'form-error'} role="status">{outcome.message}</p>}
      </div>
    </Sheet>
  )
}
