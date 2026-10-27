/**
 * 设置: everything that is not watching, in one window. Sections run across the top; each
 * keeps its own pages down the left. Nothing here is needed to start watching.
 *
 * The 倒计时样式 section is a doorway rather than a page: the editor needs the whole window,
 * so it opens in place of the player (an in-page route that keeps both streams loaded).
 */

import { useEffect, useRef, useState } from 'react'
import { apiClient } from '../app/apiClient'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import type { DecoderPreferenceState } from '../../electron/decoderPreferences'
import type { LoginStatus } from '../../electron/login'
import type { ToolsStatus } from '../../electron/toolsService'
import { AppUpdateSettings } from './about/AppUpdate'
import { CaptureSettings } from './capture/Capture'
import { routeLink } from '../app/navigate'
import { DouyuDesk } from './douyu/DouyuDesk'
import { RoomInsights } from './insights/RoomInsights'
import { DanmakuRecords, type RecordsTab } from './records/DanmakuRecords'
import { Icon, Segmented, Sheet, SideTabs, Switch } from './kit'
import { PipSettings } from './pip/PipSettings'

export type SettingsSection = 'douyu' | 'records' | 'insights' | 'editor' | 'general'

/** Where 设置 opens, and for 弹幕记录 which page and user. */
export interface SettingsTarget { section: SettingsSection; records?: { tab: RecordsTab; uid?: string } }

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'general', label: '通用' },
  { id: 'douyu', label: '斗鱼' },
  { id: 'records', label: '弹幕记录' },
  { id: 'insights', label: '房间数据' },
  { id: 'editor', label: '倒计时样式' },
]

export function SettingsSheet({ target, room, onClose, onWatch, onFill }: {
  target: SettingsTarget
  /** The connected danmaku room; 房间数据 and 弹幕记录 are about it. */
  room: string | null
  onClose: () => void
  onWatch: (room: string) => void
  onFill: (text: string) => void
}): React.ReactNode {
  const [section, setSection] = useState<SettingsSection>(target.section)
  const huya = room?.startsWith('huya:') === true
  useEffect(() => setSection(target.section), [target])
  return (
    <Sheet title="设置" onClose={onClose} wide>
      <div className="settings">
        <nav className="settings-tabs" role="tablist" aria-label="设置分区">
          {SECTIONS.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={section === item.id}
              className={section === item.id ? 'is-on' : undefined} onClick={() => setSection(item.id)}>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="settings-body" role="tabpanel" aria-label={SECTIONS.find((item) => item.id === section)?.label}>
          {section === 'general' && <General />}
          {huya && ['douyu', 'records', 'insights'].includes(section) && (
            <p className="settings-empty">当前虎牙房间仅支持只读弹幕, 斗鱼操作与统计暂不可用</p>
          )}
          {section === 'douyu' && !huya && <DouyuDesk onWatch={(next) => { onWatch(next); onClose() }} />}
          {section === 'records' && !huya && (
            <DanmakuRecords initialTab={target.records?.tab ?? 'history'} initialUid={target.records?.uid} room={room}
              onFill={(text) => { onFill(text); onClose() }} />
          )}
          {section === 'insights' && !huya && (room
            ? <RoomInsights room={room} />
            : <p className="settings-empty">连接斗鱼弹幕房间后显示房间数据</p>)}
          {section === 'editor' && <EditorDoor onClose={onClose} />}
        </div>
      </div>
    </Sheet>
  )
}

type GeneralPage = 'youtube' | 'align' | 'decoding' | 'pip' | 'capture' | 'tools' | 'about'
const GENERAL: { id: GeneralPage; label: string }[] = [
  { id: 'youtube', label: 'YouTube' },
  { id: 'align', label: '对齐' },
  { id: 'decoding', label: '解码' },
  { id: 'pip', label: '画中画' },
  { id: 'capture', label: '截图与 GIF' },
  { id: 'tools', label: '取流工具' },
  { id: 'about', label: '关于' },
]

function General(): React.ReactNode {
  const [page, setPage] = useState<GeneralPage>('youtube')
  return (
    <SideTabs label="通用" value={page} onChange={setPage} tabs={GENERAL}>
      <div className="settings-page">
        {page === 'youtube' && <YouTubeAccount />}
        {page === 'align' && <AlignPrefs />}
        {page === 'decoding' && <Decoding />}
        {page === 'pip' && <Group title="画中画"><PipSettings /></Group>}
        {page === 'capture' && <Group title="截图与 GIF"><CaptureSettings /></Group>}
        {page === 'tools' && <Tools />}
        {page === 'about' && <Group title="关于"><AppUpdateSettings /></Group>}
      </div>
    </SideTabs>
  )
}

function EditorDoor({ onClose }: { onClose: () => void }): React.ReactNode {
  return (
    <div className="settings-door">
      <p>倒计时样式告诉自动对齐比赛倒计时在画面的哪个位置、长什么样。打开编辑器后可从录像或截图教会每个数字，两路直播保持载入。</p>
      <a className="btn-solid" {...routeLink('/admin', onClose)}><Icon name="tune" />打开倒计时样式编辑器</a>
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }): React.ReactNode {
  return (
    <section className="group" aria-label={title}>
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function useMounted(): React.RefObject<boolean> {
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  return mounted
}

function YouTubeAccount(): React.ReactNode {
  const session = useSession()
  const { settings } = useSessionSnapshot()
  const mounted = useMounted()
  const [status, setStatus] = useState<LoginStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const refresh = async (): Promise<void> => {
    const result = await apiClient.loginStatus()
    if (!mounted.current) return
    if (result.ok && result.value?.youtube) setStatus(result.value)
    else if (!result.ok) setMessage(result.message)
  }
  useEffect(() => { void refresh() }, [])

  const act = async (logout: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage(logout ? '' : '请在弹出的 Chrome 窗口中登录，完成后关闭该窗口')
    try {
      const result = logout ? await apiClient.logout('youtube') : await apiClient.login('youtube')
      if (!mounted.current) return
      setMessage(result.ok ? (logout ? '已退出' : '已登录，重新载入画面后生效') : result.message)
      await refresh()
    } finally { if (mounted.current) setBusy(false) }
  }
  const youtube = status?.youtube

  return (
    <Group title="YouTube">
      <div className="row-split">
        <span>
          {youtube?.loggedIn ? '已登录' : '未登录'}
          {youtube?.expiresAt ? <span className="muted">，{new Date(youtube.expiresAt * 1000).toLocaleDateString('zh-CN')} 到期</span> : null}
        </span>
        <span className="row-end">
          {youtube?.cookieCount ? <button type="button" className="btn-quiet small" disabled={busy} onClick={() => void act(true)}>退出</button> : null}
          <button type="button" className="btn-solid small" disabled={busy} onClick={() => void act(false)}>{youtube?.loggedIn ? '重新登录' : '登录'}</button>
        </span>
      </div>
      <p className="muted">出现「请确认你不是机器人」提示或观看会员直播时需要登录。</p>
      {message && <p className="muted" role="status">{message}</p>}
      <Switch label="自动使用最高画质" detail="可用时直接载入 1440p、4K 等最高清晰度，网络较慢时可关闭"
        checked={settings.preferAdaptive} onChange={(preferAdaptive) => session.updateSettings({ preferAdaptive })} />
    </Group>
  )
}

function AlignPrefs(): React.ReactNode {
  const session = useSession()
  const { settings } = useSessionSnapshot()
  return (
    <Group title="对齐">
      <div className="field-stack">
        <span className="field-label">单击步长</span>
        <Segmented label="单击步长" value={settings.smallStepSeconds}
          onChange={(seconds) => session.updateSettings({ smallStepSeconds: seconds, largeStepSeconds: Math.max(seconds, settings.largeStepSeconds) })}
          options={[0.1, 0.25, 0.5, 1].map((value) => ({ value, label: `${value} 秒` }))} />
      </div>
      <div className="field-stack">
        <span className="field-label">长按或 Shift 步长</span>
        <Segmented label="长按步长" value={settings.largeStepSeconds}
          onChange={(seconds) => session.updateSettings({ largeStepSeconds: Math.max(seconds, settings.smallStepSeconds) })}
          options={[2, 5, 10].map((value) => ({ value, label: `${value} 秒` }))} />
      </div>
      <div className="field-stack">
        <span className="field-label">倒计时识别时长</span>
        <Segmented label="倒计时识别时长" value={settings.detectWindowSeconds} onChange={(seconds) => session.setDetectWindow(seconds)}
          options={[{ value: 2, label: '2 秒（较快）' }, { value: 3, label: '3 秒（较稳）' }]} />
      </div>
      <div className="field-stack">
        <span className="field-label">跳转阈值</span>
        <Segmented label="跳转阈值" value={settings.seekThresholdSeconds} onChange={(seconds) => session.setSeekThreshold(seconds)}
          options={[1, 1.5, 2].map((value) => ({ value, label: `${value} 秒` }))} />
      </div>
    </Group>
  )
}

const modeName = (mode: DecoderPreferenceState['mode']): string => mode === 'software' ? '软件解码' : '硬件解码'

function Decoding(): React.ReactNode {
  const mounted = useMounted()
  const [state, setState] = useState<DecoderPreferenceState | null>(null)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void apiClient.getDecoderPreferences().then((result) => {
      if (!live) return
      if (result.ok) setState(result.value)
      else setError(result.message)
      setPending(false)
    })
    return () => { live = false }
  }, [])
  const save = async (software: boolean): Promise<void> => {
    if (pending || !state) return
    setPending(true)
    setError('')
    try {
      const result = await apiClient.setDecoderPreferences(software ? 'software' : 'auto')
      if (!mounted.current) return
      if (result.ok) setState(result.value)
      else setError(result.message)
    } finally { if (mounted.current) setPending(false) }
  }
  return (
    <Group title="解码">
      <Switch label="软件解码" detail="画面出现花屏、绿屏或黑屏时启用，重启应用后生效"
        checked={state?.mode === 'software'} disabled={pending || !state} onChange={(on) => void save(on)} />
      {state?.restartRequired && <p className="note-warn">重启后改为{modeName(state.mode)}，当前仍是{modeName(state.effectiveMode)}</p>}
      {state?.forcedByCommandLine && <p className="muted">启动参数强制了软件解码</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </Group>
  )
}

const SOURCE_NAME = { external: '自定义', managed: '已更新', bundled: '内置', PATH: '系统' } as const

function Tools(): React.ReactNode {
  const mounted = useMounted()
  const [status, setStatus] = useState<ToolsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const running = busy || (!!status && ['checking', 'downloading', 'verifying'].includes(status.update.phase))
  useEffect(() => {
    void apiClient.getToolsStatus().then((result) => {
      if (!mounted.current) return
      if (result.ok && Array.isArray(result.value?.tools)) setStatus(result.value)
      else if (!result.ok) setError(result.message)
    })
  }, [])
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      void apiClient.getToolsStatus().then((result) => {
        if (mounted.current && result.ok && Array.isArray(result.value?.tools)) setStatus(result.value)
      })
    }, 750)
    return () => clearInterval(timer)
  }, [running, mounted])
  const act = async (target?: 'previous' | 'bundled'): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = target ? await apiClient.restoreYtdlp(target) : await apiClient.updateYtdlp()
      if (!mounted.current) return
      if (result.ok) setStatus(result.value)
      else setError(result.message)
    } finally { if (mounted.current) setBusy(false) }
  }
  const update = status?.update
  return (
    <Group title="取流工具">
      <dl className="facts">
        {status?.tools.map((tool) => (
          <div key={tool.name}><dt>{tool.name}</dt><dd className="num">{tool.version}<span className="muted"> · {SOURCE_NAME[tool.source]}</span></dd></div>
        ))}
      </dl>
      <p className="muted">YouTube 无法打开直播时，可先更新 yt-dlp 后重试。</p>
      <div className="row-end">
        <button type="button" className="btn-quiet small" disabled={running || !update?.previousVersion} onClick={() => void act('previous')}>恢复上一版本</button>
        <button type="button" className="btn-quiet small" disabled={running || !update?.activeVersion} onClick={() => void act('bundled')}>恢复内置版本</button>
        <button type="button" className="btn-solid small" disabled={running || !status} onClick={() => void act()}>更新 yt-dlp</button>
      </div>
      {update && update.phase !== 'idle' && (
        <p className="muted" role="status">
          {update.message}
          {update.phase === 'downloading' && update.totalBytes > 0 ? ` ${Math.floor(update.downloadedBytes * 100 / update.totalBytes)}%` : ''}
        </p>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </Group>
  )
}
