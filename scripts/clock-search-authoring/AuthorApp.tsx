import { useEffect, useRef, useState } from 'react'
import type { BasicClockSearchConfig } from '../../src/core/basicClockSearch'
import type { RoiRect } from '../../src/core/profileSchema'
import { BasicRegionSheet } from '../../src/studio/BasicRegionSheet'
import { RoiWindow } from '../../src/studio/editor/RoiWindow'
import './author.css'

interface AuthorState { config: BasicClockSearchConfig; writable: boolean; configPath: string }
interface ClockSearchAuthorApi {
  getState(): Promise<AuthorState>
  save(roi: RoiRect): Promise<AuthorState>
}
declare global { interface Window { clockSearchAuthor?: ClockSearchAuthorApi } }

export function AuthorApp(): React.ReactNode {
  const api = window.clockSearchAuthor
  const [state, setState] = useState<AuthorState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [media, setMedia] = useState<{ url: string; name: string } | null>(null)
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [ready, setReady] = useState(false)
  const [draft, setDraft] = useState<RoiRect | null>(null)
  const [framing, setFraming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const host = useRef<HTMLDivElement | null>(null)
  const mounted = useRef(true)
  const writePending = useRef(false)
  useEffect(() => {
    let active = true
    mounted.current = true
    if (!api) setError('制作工具连接不可用, 请通过制作命令启动.')
    else void api.getState().then(value => {
      if (!active) return
      setState(value); setDraft(value.config.roi)
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '无法读取生产配置, 请重新启动制作工具.') })
    return () => { active = false; mounted.current = false }
  }, [api])
  useEffect(() => () => { if (media) URL.revokeObjectURL(media.url) }, [media])
  // Only the narrow authoring API knows whether this launch explicitly used --reset.
  const locked = saved || !!state && !state.writable
  const visibleRoi = locked ? state?.config.roi ?? null : draft
  const choose = (file: File): void => {
    if (locked || saving) return
    setFraming(false); setReady(false); setSize({ width: 0, height: 0 }); setDraft(null); setError(null)
    setMedia({ url: URL.createObjectURL(file), name: file.name })
  }
  const observeVideo = (element: HTMLVideoElement): void => {
    setSize({ width: element.videoWidth, height: element.videoHeight })
    setReady(element.readyState >= 2 && element.videoWidth > 0 && element.videoHeight > 0)
  }
  const save = async (): Promise<void> => {
    if (!api || !state || locked || !draft || !ready || writePending.current) return
    writePending.current = true
    setSaving(true); setError(null)
    try {
      const result = await api.save({ ...draft })
      if (!mounted.current) return
      setState(result); setDraft(result.config.roi); setSaved(true); setFraming(false)
    } catch (reason) {
      writePending.current = false
      if (mounted.current) setError(reason instanceof Error ? reason.message : '写入失败, 请重新启动制作工具后重试.')
    } finally { if (mounted.current) setSaving(false) }
  }

  return <main className="studio clock-search-author">
    <header className="clock-search-author__header">
      <p className="clock-search-author__eyebrow">生产制作工具</p>
      <h1>基础模式寻找区间</h1>
      <p>在样例录像上手动设定一次自动寻找区间, 写入后固定用于后续构建. 正式应用不提供该区间的修改入口.</p>
    </header>
    {error && <p className="clock-search-author__error" role="alert">{error}</p>}
    {!state ? <p className="clock-search-author__status" role="status">{error ? '尚未读取到配置.' : '正在读取生产配置...'}</p> : <>
      <section className="clock-search-author__config" aria-label="生产配置">
        <div><strong>{locked ? '只读配置' : state.config.configured ? '重新制作' : '尚未设定'}</strong><code>{state.configPath}</code></div>
        <p>{saved ? '已写入生产配置, 下次构建后生效'
          : locked ? '生产寻找区间已固定, 本工具当前只读.' : '选择本地样例录像并手动框选, 确认后再写入生产配置.'}</p>
        {locked && <p>如需重新制作, 请通过制作命令的 --reset 参数启动.</p>}
        {visibleRoi && <dl className="clock-search-author__coordinates" aria-label={locked ? '已写入的比例范围' : '待写入的比例范围'}>
          {([['左侧', visibleRoi.x], ['顶部', visibleRoi.y], ['宽度', visibleRoi.w], ['高度', visibleRoi.h]] as const).map(([label, value]) =>
            <div key={label}><dt>{label}</dt><dd>{(value * 100).toFixed(2)}%</dd></div>)}
        </dl>}
      </section>
      {!locked && <div className="clock-search-author__actions">
        <label className="btn-quiet file-pick">选择样例录像
          <input type="file" accept="video/*" disabled={saving} aria-label="选择样例录像" onChange={event => {
            const file = event.target.files?.[0]
            if (file) choose(file)
            event.target.value = ''
          }} />
        </label>
        <button type="button" className="btn-quiet" disabled={!ready || !video || saving} onClick={() => setFraming(true)}>框选生产寻找区间</button>
        <button type="button" className="btn-solid" disabled={!draft || !ready || saving} onClick={() => void save()}>{saving ? '正在写入...' : '写入生产配置'}</button>
      </div>}
      {media ? <section className="clock-search-author__sample" aria-label="本地样例录像">
        <p>{media.name}</p>
        <div className="clock-search-author__video" ref={host}>
          <video ref={setVideo} src={media.url} controls muted playsInline preload="metadata" aria-label="样例录像"
            onLoadedMetadata={event => observeVideo(event.currentTarget)} onLoadedData={event => observeVideo(event.currentTarget)}
            onEmptied={() => setReady(false)} onError={() => { setReady(false); setError('样例录像无法播放, 请使用应用支持的视频格式.') }} />
          {visibleRoi && size.width > 0 && <RoiWindow roi={visibleRoi} onChange={() => {}} videoWidth={size.width} videoHeight={size.height}
            hostRef={host} readOnly label={locked ? '生产寻找区间' : '待写入区间'} />}
        </div>
        <p className="clock-search-author__hint">可使用播放器控件定位样例画面. 视频只在本机读取, 不运行识别.</p>
      </section> : <p className="clock-search-author__empty">{locked ? '固定比例范围已显示在上方.' : '尚未选择样例录像. 选择文件不会自动设定或写入范围.'}</p>}
    </>}
    {framing && video && media && !locked && <BasicRegionSheet video={video} sourceToken={media.url} initial={draft}
      title="生产自动寻找区间" saveLabel="使用此区间" label="样例录像当前帧"
      instructions="手动框住可能出现倒计时的通用区域. 这里只准备待写入范围, 确认后仍需点击写入生产配置."
      onSave={roi => setDraft({ ...roi })} onClose={() => setFraming(false)} />}
  </main>
}
