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

import { useState } from 'react'
import { apiClient } from '../app/apiClient'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { roleName } from '../app/session'
import { describeSource, parseSourceInput, toDescriptor } from '../core/mediaSources'
import { SOURCE_ROLES } from '../core/types'
import type { MediaDescriptor, SourceRole } from '../core/types'

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

        <footer className="dialog-footer">
          <span className="hint">
            官方画面建议用 Twitch 频道，国内解说用斗鱼房间号；直连失败时可粘贴 m3u8 / mp4 地址。
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
    const result = await apiClient.resolve(parsed.url, parsed.platform)
    setBusy(false)

    if (!result.ok) {
      setProblem({ message: result.message })
      return
    }
    if (!result.value.ok) {
      const { failure } = result.value
      setProblem({ message: failure.message, hint: failure.hint })
      return
    }

    const stream = result.value.stream
    setNotes(stream.notes ?? [])
    await load(
      toDescriptor(
        { ...parsed, kind: stream.kind, label: stream.label },
        { url: stream.url, viaProxy: stream.requiresProxy },
      ),
    )
    // Douyu resolution also tells us the danmaku room, which is the only way the relay
    // can subscribe. Only the commentary side carries danmaku.
    if (role === 'commentary' && stream.danmakuRoom) session.connectDanmaku(stream.danmakuRoom)
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
              role === 'official' ? 'twitch.tv/esl_csgo 或 …m3u8' : 'douyu.com/9999 或 …m3u8'
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
            <button type="button" className="ghost" onClick={() => session.unloadSource(role)}>
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
