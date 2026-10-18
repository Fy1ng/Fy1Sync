/**
 * Source setup for both roles.
 *
 * Resolution and remote media registration go through main, and a platform refusal comes back as a structured
 * failure rather than an exception — so "这个房间没在直播" and "网络断了" stay different
 * messages, and a refusal that has a manual workaround says so. See docs/platform-notes.md.
 *
 * The built-in test sources exist for development and for the E2E suite: two looping local
 * clips with a known offset, so sync can be exercised without a live match.
 */

import { useEffect, useState } from 'react'
import { apiClient } from '../app/apiClient'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { roleName } from '../app/session'
import { describeSource, parseSourceInput, toDescriptor } from '../core/mediaSources'
import { SOURCE_ROLES } from '../core/types'
import type { MediaDescriptor, SourceRole } from '../core/types'
import type { LoginPlatform, LoginStatus } from '../../electron/login'
import { bufferStatusText } from './bufferStatus'

/** Looping local fixtures, also used by the E2E specs. */
/**
 * The local fixtures from `npm run fixtures`. They are not committed (ffmpeg output), so
 * these buttons 404 until that script has been run — which is why each one names what it
 * is rather than pretending to be a real stream.
 */
const TEST_SOURCES: { label: string; url: string; note: string }[] = [
  { label: '测试源 · 官方画面', url: '/test-sources/official.mp4', note: '基准，倒计时 0:20 → 0:00' },
  { label: '测试源 · 解说（+5s）', url: '/test-sources/commentary.mp4', note: '相对官方落后 5s' },
  { label: '测试源 · 解说 HLS', url: '/test-sources/commentary-hls/index.m3u8', note: '走 hls.js 路径' },
]

export function SourceDialog({ onClose }: { onClose: () => void }): React.ReactNode {
  const snapshot = useSessionSnapshot()

  return (
    <div className="dialog-backdrop" onPointerDown={onClose}>
      <div
        className="dialog source-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="片源设置"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <h2>片源设置</h2>
          <button type="button" className="ghost small" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="source-columns">
          {SOURCE_ROLES.map((role) => (
            <RolePanel key={role} role={role} />
          ))}
        </div>

        <Accounts />

        <footer className="dialog-footer">
          <span className="hint">
            官方画面建议用 YouTube 直播, 也支持 Twitch; 解说用斗鱼或 B 站. 可粘贴 m3u8 / mp4 / flv 地址.
          </span>
          <button type="button" className="primary" onClick={onClose}>
            完成
          </button>
        </footer>

        {snapshot.danmaku.error && <p className="dialog-error">{snapshot.danmaku.error}</p>}
      </div>
    </div>
  )
}

function RolePanel({ role }: { role: SourceRole }): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const state = snapshot.media[role]
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<{ message: string; hint?: string } | null>(null)
  const [notes, setNotes] = useState<string[]>([])

  const load = async (descriptor: MediaDescriptor): Promise<void> => {
    setBusy(true)
    try {
      await session.loadSource(role, descriptor)
    } finally {
      setBusy(false)
    }
  }

  const submit = async (): Promise<void> => {
    setProblem(null)
    setNotes([])
    const parsed = parseSourceInput(input)
    if (!parsed.ok) {
      setProblem({ message: parsed.message })
      return
    }

    // Local object URLs and fixtures need no main-process registration.
    if (!parsed.needsResolve) {
      await load(toDescriptor(parsed))
      return
    }

    setBusy(true)
    const generation = session.beginSourceChange(role)
    try {
      const result = await apiClient.resolve(parsed.url, parsed.platform, role)
      if (generation !== session.sourceRevision(role)) return
      if (!result.ok) { setProblem({ message: result.message }); return }
      if (!result.value.ok) {
        const { failure } = result.value
        setProblem({ message: failure.message, hint: failure.hint })
        return
      }

      const stream = result.value.stream
      setNotes(stream.notes ?? [])
      await session.loadSource(role, {
        ...toDescriptor(
          { ...parsed, kind: stream.kind, label: stream.label },
          { url: stream.url, viaProxy: stream.requiresProxy },
        ), sourceQualities: stream.qualities, sourceQuality: stream.quality,
      })
      // Only commentary carries the independently resolved danmaku room.
      if (role === 'commentary' && stream.danmakuRoom) session.connectDanmaku(stream.danmakuRoom)
    } finally { setBusy(false) }
  }

  return (
    <section className="source-panel">
      <h3>{roleName(role)}</h3>
      <p className="source-current">
        当前：{describeSource(state.descriptor)}
        {state.status === 'error' && state.error && (
          <span className="source-error">（{state.error.message}）</span>
        )}
      </p>

      {snapshot.buffers[role] && <p className="hint" role="status">{bufferStatusText(snapshot.buffers[role]!)}</p>}
      {(state.descriptor?.sourceQualities?.length ?? 0) > 0 && <label className="field">
        <span>画质</span>
        <select value={state.descriptor?.sourceQuality ?? ''} disabled={busy || snapshot.qualityBusy[role]}
          onChange={(event) => void session.changeSourceQuality(role, event.target.value)}>
          {state.descriptor!.sourceQualities!.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>}

      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label className="field">
          <span>直播间或媒体地址</span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={
              role === 'official' ? 'youtube.com/watch?v=... 或 twitch.tv/esl_csgo' : 'douyu.com/9999 或 live.bilibili.com/房间号'
            }
          />
        </label>
        <div className="source-actions">
          <button type="submit" className="primary" disabled={busy || input.trim() === ''}>
            {busy ? '处理中…' : '加载'}
          </button>
          <label className="file-button">
            本地文件
            <input
              type="file"
              disabled={busy}
              accept="video/*"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (!file) return
                // An object URL keeps the file local; nothing is uploaded.
                void load({
                  kind: 'file',
                  url: URL.createObjectURL(file),
                  input: file.name,
                  label: file.name,
                  loop: false,
                  viaProxy: false,
                  platform: 'file',
                })
              }}
            />
          </label>
          {state.status !== 'empty' && (
            <button type="button" className="ghost" disabled={busy} onClick={() => session.unloadSource(role)}>
              卸载
            </button>
          )}
        </div>
      </form>

      {problem && (
        <div className="source-problem" role="alert">
          <p>{problem.message}</p>
          {problem.hint && <p className="hint">{problem.hint}</p>}
        </div>
      )}

      {notes.length > 0 && (
        <ul className="source-notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      <details className="source-tests">
        <summary>内置测试源</summary>
        {TEST_SOURCES.map((source) => (
          <button
            key={source.url}
            type="button"
            disabled={busy}
            onClick={() =>
              void load({
                kind: 'test',
                url: source.url,
                input: source.url,
                label: source.label,
                loop: true,
                viaProxy: false,
                platform: 'test',
              })
            }
          >
            {source.label}
            <span className="hint">{source.note}</span>
          </button>
        ))}
      </details>

      {role === 'commentary' && <DanmakuRoomField />}
    </section>
  )
}

function Accounts(): React.ReactNode {
  const [status, setStatus] = useState<LoginStatus | null>(null)
  const [busy, setBusy] = useState<LoginPlatform | null>(null)
  const [message, setMessage] = useState('')
  const refresh = async () => {
    const result = await apiClient.loginStatus()
    if (result.ok && result.value?.youtube && result.value?.douyu) setStatus(result.value)
    else if (!result.ok) setMessage(result.message)
  }
  useEffect(() => { void refresh() }, [])
  const action = async (platform: LoginPlatform, logout = false) => {
    if (busy) return
    setBusy(platform)
    setMessage(logout ? '正在清除登录信息' : '请在打开的 Chrome 窗口中登录, 完成后关闭该窗口')
    try {
      const result = logout ? await apiClient.logout(platform) : await apiClient.login(platform)
      setMessage(result.ok ? (logout ? '已退出登录并删除专用浏览器资料' : '登录信息已保存') : result.message)
      await refresh()
    } finally { setBusy(null) }
  }
  return <section className="account-section" aria-label="账号">
    <h3>账号</h3>
    <p className="hint">登录可选. YouTube 验证和斗鱼原画可能需要登录. 登录完成后请重新加载片源.</p>
    {(['youtube', 'douyu'] as const).map((platform) => <div key={platform} className="source-actions">
      <button type="button" disabled={busy !== null} onClick={() => void action(platform)}>
        {platform === 'youtube' ? '登录 YouTube' : '登录斗鱼'}
      </button>
      <span className="hint">{status?.[platform].loggedIn ? '已登录' : '未登录'}
        {status?.[platform].expiresAt ? `, 到期 ${new Date(status[platform].expiresAt! * 1000).toISOString().slice(0, 10)}` : ''}
      </span>
      {status?.[platform].cookieCount ? <button type="button" className="ghost" disabled={busy !== null}
        onClick={() => void action(platform, true)}>退出登录</button> : null}
    </div>)}
    {message && <p role="status" className="hint">{message}</p>}
  </section>
}

/** Danmaku can be subscribed independently: the room may differ from the video source. */
function DanmakuRoomField(): React.ReactNode {
  const session = useSession()
  const { danmaku } = useSessionSnapshot()
  const [room, setRoom] = useState('')

  return (
    <form
      className="danmaku-room"
      onSubmit={(event) => {
        event.preventDefault()
        const value = room.trim()
        if (value) session.connectDanmaku(value)
      }}
    >
      <label className="field">
        <span>弹幕房间号</span>
        <input value={room} onChange={(event) => setRoom(event.target.value)} placeholder="例如 9999" />
      </label>
      <div className="source-actions">
        <button type="submit" disabled={room.trim() === ''}>
          连接
        </button>
        {danmaku.connected && (
          <button type="button" className="ghost" onClick={() => session.disconnectDanmaku()}>
            断开
          </button>
        )}
      </div>
      <p className="hint">
        {danmaku.connected
          ? `已连接房间 ${danmaku.room}${danmaku.dropped > 0 ? `，已过滤 ${danmaku.dropped} 条` : ''}`
          : '未连接弹幕'}
      </p>
    </form>
  )
}
