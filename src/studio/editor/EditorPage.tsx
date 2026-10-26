/**
 * The countdown style editor (`/admin`).
 *
 * This is where a recognition profile is made: frame the scoreboard clock on a sample,
 * tune the threshold until the digits come out clean, fix the glyph cuts, and teach each
 * character from real frames. The player then uses those templates to read the countdown
 * and align two streams.
 *
 * The picture fills the page and everything that acts on it sits in one rail, in the
 * order the work happens. The library and file actions are menus in the top bar because
 * they are used once per session, not once per glyph.
 *
 * Two rules carry over unchanged. Recognition runs through the same `recognizeFrame` the
 * worker calls, so 验证当前帧 tests the real pipeline. And every sample comes from a decoded
 * frame of the user's own video: a template drawn from a system font does not match a
 * broadcast's anti-aliased, overlay-blended digits.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createEmptyProfile,
  parseProfile,
  profileReadiness,
  type ClockChar,
  type RecognitionProfile,
  type RoiRect,
} from '../../core/profileSchema'
import { compileTemplates, recognizeFrame, type RecognizeResult } from '../../core/templateMatch'
import type { GlyphBox } from '../../core/segmentation'
import { profileStore, type StoredProfile } from '../../core/profileStore'
import { apiClient, issuesFrom, type PresetSummary } from '../../app/apiClient'
import { FrameGrabber, FULL_FRAME_ROI, type GrabbedFrame } from '../../recognition/frameGrabber'
import { useSession } from '../../app/SessionContext'
import { routeLink } from '../../app/navigate'
import { Icon } from '../kit'
import { analyzeFrame, drawGray, drawMask, sampleFromBox } from './framePipeline'
import { RoiWindow } from './RoiWindow'
import { decodeScreenshot, imageFromClipboard } from './screenshotSample'
import { FileMenu, LibraryMenu } from './library'
import { BinarizeSection, GlyphSection, ParamsSection, RegionSection, SampleSection } from './rail'
import '../studio.css'
import './editor.css'

interface Message {
  kind: 'info' | 'warn' | 'error'
  text: string
  /** Set when a publish lost an ETag race; the note then offers the two ways out. */
  conflict?: { currentEtag?: string }
}

const TYPED_CHARS = new Set<string>(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':'])

/** Only the trusted local app frame can invoke preset writes in main. */
export default function EditorPage(): React.ReactNode {
  const session = useSession()
  const [profile, setProfile] = useState<RecognitionProfile>(() => session.takeEditingCandidate() ?? createEmptyProfile())
  useEffect(() => session.clearEditingCandidate(), [session])
  const [etag, setEtag] = useState<string | undefined>(undefined)
  const [publishedProfile, setPublishedProfile] = useState<RecognitionProfile | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState<'draft' | 'publish' | null>(null)
  const saveInFlight = useRef(false)
  const mounted = useRef(false)
  const editRevision = useRef(0)
  const documentRevision = useRef(0)
  const libraryRevision = useRef(0)
  const profileRef = useRef(profile)
  profileRef.current = profile
  const publishedCurrent = useMemo(() => publishedProfile !== null && JSON.stringify(profile) === JSON.stringify(publishedProfile), [profile, publishedProfile])
  const [message, setMessage] = useState<Message | null>(null)
  const [presets, setPresets] = useState<PresetSummary[]>([])
  const [drafts, setDrafts] = useState<StoredProfile[]>([])

  const [sampleUrl, setSampleUrl] = useState('')
  /** A still screenshot replaces the video; the video controls do not apply to it. */
  const [sampleKind, setSampleKind] = useState<'video' | 'image'>('video')
  const [sampleName, setSampleName] = useState('')
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 })
  const [mediaTime, setMediaTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playing, setPlaying] = useState(false)

  const [frame, setFrame] = useState<GrabbedFrame | null>(null)
  const [boxes, setBoxes] = useState<GlyphBox[]>([])
  const [selected, setSelected] = useState(-1)
  const [recognized, setRecognized] = useState<RecognizeResult | null>(null)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const grabberRef = useRef(new FrameGrabber())
  const grayCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const binaryCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const objectUrlRef = useRef<string>('')

  const readiness = useMemo(() => profileReadiness(profile), [profile])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; documentRevision.current++; libraryRevision.current++ }
  }, [])

  // Re-derived whenever the frame, the ROI or the thresholds change: that is exactly the
  // set of inputs the preview depends on, and re-segmenting a clock-sized crop is cheap.
  const analysis = useMemo(
    () => (frame ? analyzeFrame(frame, profile.roi, profile.preprocess) : null),
    [frame, profile.roi, profile.preprocess],
  )

  // Manual box edits live in their own state so they survive a re-render, but a fresh
  // analysis replaces them: the old boxes indexed into a different image.
  useEffect(() => {
    setBoxes(analysis ? analysis.boxes : [])
    setSelected(-1)
    setRecognized(null)
  }, [analysis])

  useEffect(() => {
    if (analysis) drawGray(grayCanvasRef.current, analysis.gray)
  }, [analysis])

  useEffect(() => {
    if (analysis) drawMask(binaryCanvasRef.current, analysis.binary)
  }, [analysis])

  const refreshLibrary = useCallback(async () => {
    const revision = ++libraryRevision.current
    const [remote, local] = await Promise.all([apiClient.listPresets(), profileStore.list().catch(() => [])])
    if (!mounted.current || revision !== libraryRevision.current) return
    if (remote.ok) setPresets(remote.value.presets)
    else setMessage({ kind: 'warn', text: `预设列表读取失败：${remote.message}` })
    setDrafts(local)
  }, [])

  useEffect(() => {
    void refreshLibrary()
  }, [refreshLibrary])

  // Object URLs are revoked on replacement and on unmount; a leaked one pins the whole
  // decoded file in memory for the lifetime of the document.
  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    },
    [],
  )

  const patch = useCallback((update: Partial<RecognitionProfile>) => {
    ++editRevision.current
    if (update.id !== undefined && update.id !== profileRef.current.id) {
      ++documentRevision.current
      setEtag(undefined)
      setPublishedProfile(null)
    }
    setProfile((current) => ({ ...current, ...update }))
    setDirty(true)
  }, [])

  const setRoi = useCallback((roi: RoiRect) => patch({ roi }), [patch])

  const openSample = (file: File): void => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    const url = URL.createObjectURL(file)
    objectUrlRef.current = url
    setSampleKind('video')
    setSampleUrl(url)
    setSampleName(file.name)
    setFrame(null)
    setPlaying(false)
    setMessage(null)
  }

  const openScreenshot = useCallback(async (file: File, origin: 'file' | 'paste'): Promise<void> => {
    const decoded = await decodeScreenshot(file)
    if (!decoded.ok) {
      setMessage({ kind: 'error', text: decoded.message })
      return
    }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    const url = URL.createObjectURL(file)
    objectUrlRef.current = url
    const name = origin === 'paste' ? '粘贴的截图' : file.name
    setSampleKind('image')
    setSampleUrl(url)
    setSampleName(name)
    setVideoSize({ width: decoded.frame.width, height: decoded.frame.height })
    setMediaTime(0)
    setDuration(0)
    setPlaying(false)
    setFrame(decoded.frame)
    setMessage({ kind: 'info', text: `已载入${name}（${decoded.frame.width}×${decoded.frame.height}）` })
  }, [])

  // Ctrl+V anywhere on the editor, except into a text field, which keeps its own paste.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]')) return
      const file = imageFromClipboard(event.clipboardData)
      if (!file) return
      event.preventDefault()
      void openScreenshot(file, 'paste')
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [openScreenshot])

  const grab = useCallback(() => {
    const video = videoRef.current
    // A screenshot is already the frame; there is nothing to grab again.
    if (!video || sampleKind === 'image') return
    // The whole frame is grabbed, not just the ROI: the editor re-crops on every ROI
    // change, and re-grabbing per pixel of drag would stall on a paused decoder.
    const result = grabberRef.current.grab(video, FULL_FRAME_ROI, video.currentTime)
    if (!result.ok) {
      setMessage({ kind: 'error', text: `取帧失败（${result.reason}）：${result.detail ?? '未知原因'}` })
      return
    }
    setFrame(result.frame)
    setMessage(null)
  }, [sampleKind])

  const step = (delta: number): void => {
    const video = videoRef.current
    if (!video) return
    video.pause()
    const fps = profile.sampleFps > 0 ? profile.sampleFps : 30
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + delta / fps))
  }

  const togglePlay = (): void => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(() => undefined)
    else video.pause()
  }

  const assign = (char: ClockChar): void => {
    if (!analysis || selected < 0) return
    const box = boxes[selected]
    if (!box) return
    const sample = sampleFromBox(analysis.binary, box, char, `${sampleName || '样片'} @ ${mediaTime.toFixed(2)}s`)
    const existing = profile.templates[char] ?? []
    patch({ templates: { ...profile.templates, [char]: [...existing, sample] } })
    // Advance the selection so teaching a whole clock is one keystroke per glyph.
    setSelected(selected + 1 < boxes.length ? selected + 1 : -1)
  }

  const removeSample = (char: ClockChar, id: string): void => {
    const kept = (profile.templates[char] ?? []).filter((sample) => sample.id !== id)
    const templates = { ...profile.templates }
    if (kept.length > 0) templates[char] = kept
    else delete templates[char]
    patch({ templates })
  }

  const verifyFrame = (): void => {
    if (!frame) return
    const result = recognizeFrame(
      // `recognizeFrame` names the buffer `data`; the grabber names it `pixels`.
      { data: frame.pixels, width: frame.width, height: frame.height },
      profile,
      compileTemplates(profile),
      { mediaTime: frame.mediaTime, wallTime: frame.wallTime, frameIndex: 0 },
      { segment: {} },
    )
    setRecognized(result)
  }

  // Keyboard: digits and ':' teach the selected box, ←/→ step a frame, Space plays. Typing
  // into a field keeps its keys; buttons keep Space and the arrows but not the digits, so
  // clicking a glyph box and then typing the clock works.
  const keys = useRef({ assign, step, togglePlay, video: false })
  keys.current = { assign, step, togglePlay, video: sampleUrl !== '' && sampleKind === 'video' }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('textarea, select, [contenteditable="true"], .pop') || (target instanceof HTMLInputElement && target.type !== 'range')) return
      if (TYPED_CHARS.has(event.key)) {
        event.preventDefault()
        keys.current.assign(event.key as ClockChar)
        return
      }
      if (!keys.current.video || target.closest('button, input, [role="group"]')) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        keys.current.step(event.key === 'ArrowLeft' ? -1 : 1)
      } else if (event.key === ' ') {
        event.preventDefault()
        keys.current.togglePlay()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const saveDraft = async (): Promise<void> => {
    if (saveInFlight.current) return
    saveInFlight.current = true
    setSaving('draft')
    const submitted = profile
    const revision = editRevision.current
    const document = documentRevision.current
    try {
      await profileStore.save(submitted)
      if (!mounted.current || document !== documentRevision.current) return
      const unchanged = revision === editRevision.current
      if (unchanged) setDirty(false)
      setMessage({ kind: 'info', text: unchanged ? '已保存到本机草稿，发布后才能应用到播放器'
        : '已保存提交时的草稿，当前还有未保存的修改' })
      void refreshLibrary()
    } catch (error) {
      if (mounted.current && document === documentRevision.current && revision === editRevision.current)
        setMessage({ kind: 'error', text: `草稿保存失败：${error instanceof Error ? error.message : String(error)}` })
    } finally { saveInFlight.current = false; if (mounted.current) setSaving(null) }
  }

  const publish = async (overwriteEtag?: string): Promise<void> => {
    if (saveInFlight.current) return
    saveInFlight.current = true
    setSaving('publish')
    const submitted = profile
    const revision = editRevision.current
    const document = documentRevision.current
    try {
      const result = await apiClient.savePreset(submitted.id, submitted, '', overwriteEtag ?? etag)
      if (!mounted.current || document !== documentRevision.current) return
      if (result.ok) {
        setEtag(result.value.etag)
        setPublishedProfile(submitted)
        const unchanged = revision === editRevision.current
        if (unchanged) setDirty(false)
        setMessage({ kind: 'info', text: unchanged ? `已发布为本机预设 ${submitted.id}`
          : `已发布 ${submitted.id} 提交时的版本，当前还有未发布的修改` })
        void refreshLibrary()
        return
      }
      if (revision !== editRevision.current) return
      const issues = issuesFrom(result.detail)
      // `conflict` is main's code for a stale ETag. Both ways out are offered and named
      // for what they cost: reloading drops these edits, overwriting drops the other ones.
      // Overwrite sends the ETag main reported, so it only wins against that exact version.
      if (result.code === 'conflict') {
        const currentEtag = (result.detail as { currentEtag?: unknown } | undefined)?.currentEtag
        setMessage({
          kind: 'error',
          text: `预设 ${profile.id} 已在别处被修改`,
          conflict: { currentEtag: typeof currentEtag === 'string' ? currentEtag : undefined },
        })
        return
      }
      setMessage({
        kind: 'error',
        text: `发布失败：${result.message}${issues.length ? `（${issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}）` : ''}`,
      })
    } finally { saveInFlight.current = false; if (mounted.current) setSaving(null) }
  }

  const loadPreset = async (id: string): Promise<void> => {
    const revision = ++editRevision.current
    const document = ++documentRevision.current
    const result = await apiClient.getPreset(id)
    if (!mounted.current || revision !== editRevision.current || document !== documentRevision.current) return
    if (!result.ok) {
      setMessage({ kind: 'error', text: `载入失败：${result.message}` })
      return
    }
    setProfile(result.value.profile)
    setPublishedProfile(result.value.profile)
    setEtag(result.value.etag)
    setDirty(false)
    setMessage({ kind: 'info', text: `已载入预设 ${id}` })
  }

  const loadDraft = async (id: string): Promise<void> => {
    const revision = ++editRevision.current
    const document = ++documentRevision.current
    try {
      const found = await profileStore.get(id)
      if (!mounted.current || revision !== editRevision.current || document !== documentRevision.current) return
      if (!found) {
        setMessage({ kind: 'error', text: '草稿已不存在' })
        void refreshLibrary()
        return
      }
      setProfile(found)
      setPublishedProfile(null)
      setEtag(undefined)
      setDirty(false)
      setMessage({ kind: 'info', text: `已载入草稿 ${id}` })
    } catch {
      if (mounted.current && revision === editRevision.current && document === documentRevision.current)
        setMessage({ kind: 'error', text: '草稿读取失败，当前编辑内容已保留' })
    }
  }

  const newProfile = (): void => {
    ++editRevision.current
    ++documentRevision.current
    setProfile(createEmptyProfile())
    setPublishedProfile(null)
    setEtag(undefined)
    setDirty(false)
    setMessage({ kind: 'info', text: '已新建空白样式' })
  }

  const importFile = async (file: File): Promise<void> => {
    const revision = ++editRevision.current
    const document = ++documentRevision.current
    try {
      const parsed = parseProfile(JSON.parse(await file.text()) as unknown)
      if (!mounted.current || revision !== editRevision.current || document !== documentRevision.current) return
      if (!parsed.profile) {
        setMessage({ kind: 'error', text: `导入失败：${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}` })
        return
      }
      setProfile(parsed.profile)
      setPublishedProfile(null)
      setEtag(undefined)
      setDirty(true)
      const warnings = parsed.issues.filter((issue) => issue.severity === 'warning')
      setMessage({
        kind: warnings.length ? 'warn' : 'info',
        text: warnings.length ? `已导入，注意：${warnings.map((issue) => issue.message).join('；')}` : '已导入',
      })
    } catch (error) {
      if (mounted.current && revision === editRevision.current && document === documentRevision.current)
        setMessage({ kind: 'error', text: `导入失败：${error instanceof Error ? error.message : String(error)}` })
    }
  }

  const exportFile = (): void => {
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${profile.id.replace(/\//gu, '-')}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  /**
   * Hand the current profile to the player.
   *
   * The id is also persisted, so the choice survives a restart or a reload of the page; the
   * player fetches the preset by that id, which only works if this profile is on the main
   * process and unmodified since.
   */
  const applyToPlayer = (): void => {
    if (!readiness.ready) {
      setMessage({ kind: 'warn', text: `还缺少字符样本：${readiness.missing.join(' ')}` })
      return
    }
    if (!etag || !publishedCurrent || saving) {
      setMessage({ kind: 'warn', text: '播放器读取的是已发布的预设，请先发布到本机再应用' })
      return
    }
    session.setProfileForAll(profile)
    session.updateSettings({ profileId: profile.id })
    setMessage({ kind: 'info', text: `已设为播放器的倒计时样式（${profile.id}）` })
  }

  const state = dirty ? 'dirty' : publishedCurrent ? 'published' : 'unpublished'
  const video = sampleUrl !== '' && sampleKind === 'video'

  return (
    <div className="studio editor">
      <header className="editor-bar">
        <a className="icon-btn" {...routeLink('/')} aria-label="返回播放器" title="返回播放器"><Icon name="back" /></a>
        <div className="editor-title">
          <input className="editor-name" value={profile.name} aria-label="名称" spellCheck={false}
            onChange={(event) => patch({ name: event.target.value })} />
          <input className="editor-id num" value={profile.id} aria-label="标识" placeholder="cs2/iem" spellCheck={false}
            title="小写字母、数字和斜线，发布时作为预设文件名" onChange={(event) => patch({ id: event.target.value })} />
        </div>
        <span className="editor-state" data-state={state}>{STATE_TEXT[state]}</span>
        <span className="editor-spacer" />
        <LibraryMenu presets={presets} drafts={drafts} onLoadPreset={loadPreset} onLoadDraft={loadDraft}
          onDeleteDraft={async (id) => { await profileStore.remove(id); void refreshLibrary() }} />
        <FileMenu onNew={newProfile} onImport={importFile} onExport={exportFile} />
        <span className="editor-divider" aria-hidden="true" />
        <button type="button" className="btn-quiet" disabled={saving !== null} onClick={() => void saveDraft()}>
          {saving === 'draft' ? '正在保存…' : '存为草稿'}
        </button>
        <button type="button" className="btn-quiet" disabled={saving !== null} onClick={() => void publish()}>
          {saving === 'publish' ? '正在发布…' : '发布到本机'}
        </button>
        <button type="button" className="btn-solid" onClick={applyToPlayer}>应用到播放器</button>
      </header>

      {message && (
        <div className={`editor-note is-${message.kind}`} role={message.conflict ? 'alert' : 'status'}>
          <span className="editor-note-text">{message.text}</span>
          {message.conflict && (
            <>
              <button type="button" className="btn-quiet small" onClick={() => void loadPreset(profile.id)}>
                载入对方版本（放弃本次修改）
              </button>
              {message.conflict.currentEtag && (
                <button type="button" className="btn-quiet small is-danger" disabled={saving !== null}
                  onClick={() => void publish(message.conflict?.currentEtag)}>用我的版本覆盖</button>
              )}
            </>
          )}
          <button type="button" className="editor-note-close" onClick={() => setMessage(null)} aria-label="关闭提示">
            <Icon name="close" />
          </button>
        </div>
      )}

      <main className="editor-main">
        <section className="editor-stage-col" aria-label="样片">
          <div className="editor-stage" ref={stageRef}>
            {sampleUrl && sampleKind === 'image' ? (
              <img src={sampleUrl} className="editor-media" alt={sampleName} draggable={false} />
            ) : sampleUrl ? (
              <video
                ref={videoRef}
                src={sampleUrl}
                className="editor-media"
                controls={false}
                playsInline
                muted
                onLoadedMetadata={(event) => {
                  const node = event.currentTarget
                  setVideoSize({ width: node.videoWidth, height: node.videoHeight })
                  setDuration(Number.isFinite(node.duration) ? node.duration : 0)
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onTimeUpdate={(event) => setMediaTime(event.currentTarget.currentTime)}
                onSeeked={(event) => {
                  setMediaTime(event.currentTarget.currentTime)
                  // A seek is the usual way to reach the frame you want; grabbing right
                  // after it saves a click and guarantees the preview matches the picture.
                  grab()
                }}
              />
            ) : (
              <div className="editor-empty">
                <p>载入一段比赛录像或一张截图</p>
                <p className="muted">也可以直接按 Ctrl+V 粘贴截图，文件只在本机读取</p>
              </div>
            )}
            {sampleUrl && (
              <RoiWindow roi={profile.roi} onChange={setRoi} videoWidth={videoSize.width} videoHeight={videoSize.height} hostRef={stageRef} />
            )}
          </div>

          <div className="editor-transport">
            <label className="btn-quiet small file-pick">
              选择录像
              <input type="file" accept="video/*" onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) openSample(file)
                event.target.value = ''
              }} />
            </label>
            <label className="btn-quiet small file-pick">
              选择截图
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void openScreenshot(file, 'file')
                event.target.value = ''
              }} />
            </label>
            {video ? (
              <>
                <span className="editor-transport-group">
                  <button type="button" className="icon-btn" onClick={() => step(-1)} aria-label="上一帧" title="上一帧（←）"><Icon name="back" /></button>
                  <button type="button" className="icon-btn" onClick={togglePlay} aria-label={playing ? '暂停' : '播放'} title="播放 / 暂停（空格）">
                    <Icon name={playing ? 'pause' : 'play'} />
                  </button>
                  <button type="button" className="icon-btn" onClick={() => step(1)} aria-label="下一帧" title="下一帧（→）"><Icon name="forward" /></button>
                </span>
                <input type="range" className="editor-scrub" min={0} max={Math.max(0.1, duration)} step={0.02}
                  value={Math.min(mediaTime, duration || mediaTime)} aria-label="样片进度"
                  style={{ '--fill': `${duration ? (mediaTime / duration) * 100 : 0}%` } as React.CSSProperties}
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    setMediaTime(value)
                    const node = videoRef.current
                    if (node) node.currentTime = value
                  }} />
                <span className="editor-time num"><span>{mediaTime.toFixed(2)}s</span> / {duration ? `${duration.toFixed(2)}s` : '—'}</span>
                <button type="button" className="btn-solid small" onClick={grab}>取当前帧</button>
              </>
            ) : (
              <span className="editor-transport-meta muted">
                {sampleUrl ? `${sampleName} · ${videoSize.width}×${videoSize.height}` : ''}
              </span>
            )}
          </div>
        </section>

        <aside className="editor-rail" aria-label="识别设置">
          <RegionSection roi={profile.roi} onRoi={setRoi} videoSize={videoSize} analysis={analysis}
            boxes={boxes} selected={selected} onSelect={setSelected}
            grayRef={grayCanvasRef} binaryRef={binaryCanvasRef} />
          <BinarizeSection profile={profile} onPatch={patch} />
          <GlyphSection profile={profile} readiness={readiness} boxes={boxes} selected={selected}
            bounds={analysis ? { width: analysis.binary.width, height: analysis.binary.height } : null}
            onBoxes={setBoxes} onAssign={assign} onVerify={frame ? verifyFrame : null} recognized={recognized} />
          <SampleSection profile={profile} onRemove={removeSample} />
          <ParamsSection profile={profile} onPatch={patch} />
        </aside>
      </main>
    </div>
  )
}

const STATE_TEXT = { dirty: '未保存', published: '已发布', unpublished: '未发布' } as const
