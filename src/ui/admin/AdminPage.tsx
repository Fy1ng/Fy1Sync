/**
 * Profile Editor (`/admin`).
 *
 * This is where a recognition profile is actually made: point the ROI at a scoreboard
 * clock, tune the threshold until the digits come out clean, cut the glyphs apart, and
 * teach each character from real frames. The player then uses those templates to read the
 * countdown and align two streams.
 *
 * Two decisions are worth stating up front. The editor runs recognition through the same
 * `recognizeFrame` the worker calls, so "验证当前帧" tests the real pipeline rather than a
 * lookalike. And every sample comes from a decoded frame of the user's own video — there
 * is no synthetic font rendering anywhere, because a template drawn from a system font
 * does not match a broadcast's anti-aliased, overlay-blended digits.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CLOCK_CHARS,
  DEFAULT_PREPROCESS,
  createEmptyProfile,
  parseProfile,
  profileReadiness,
  TEMPLATE_PIXELS,
  type ClockChar,
  type RecognitionProfile,
  type RoiRect,
} from '../../core/profileSchema'
import type { CountdownFormat } from '../../core/clockJump'
import { compileTemplates, recognizeFrame, type RecognizeResult } from '../../core/templateMatch'
import { unpackBitmap } from '../../core/bitmapCodec'
import {
  adjustGlyphBox,
  excludeGlyphBox,
  mergeGlyphBoxes,
  splitGlyphBox,
  type GlyphBox,
} from '../../core/segmentation'
import { profileStore, type StoredProfile } from '../../core/profileStore'
import { apiClient, issuesFrom, type PresetSummary } from '../../app/apiClient'
import { FrameGrabber, FULL_FRAME_ROI, type GrabbedFrame } from '../../recognition/frameGrabber'
import { useSession } from '../../app/SessionContext'
import { Slider } from '../controls/Slider'
import { Toggle } from '../controls/Toggle'
import { DropUp, type DropUpOption } from '../controls/DropUp'
import { analyzeFrame, drawGray, drawMask, sampleFromBox, TEMPLATE_SIZE } from './framePipeline'
import { RoiWindow } from './RoiWindow'
import { decodeScreenshot, imageFromClipboard } from './screenshotSample'

interface Message {
  kind: 'info' | 'warn' | 'error'
  text: string
  /** Set when a publish lost an ETag race; the banner then offers the two ways out. */
  conflict?: { currentEtag?: string }
}

const CLOCK_FORMAT_OPTIONS: DropUpOption<CountdownFormat>[] = [
  { value: 'm:ss', label: 'm:ss', hint: '1:45' },
  { value: 'mm:ss', label: 'mm:ss', hint: '01:45' },
  { value: 'ss', label: 'ss', hint: '仅秒数，不需要冒号模板' },
  { value: 'auto', label: '自动', hint: '按识别结果推断' },
]

/** Only the trusted local app frame can invoke preset writes in main. */
export default function AdminPage(): React.ReactNode {
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
  /** A still screenshot replaces the video stage; the video controls do not apply to it. */
  const [sampleKind, setSampleKind] = useState<'video' | 'image'>('video')
  const [sampleName, setSampleName] = useState('')
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 })
  const [mediaTime, setMediaTime] = useState(0)
  const [duration, setDuration] = useState(0)

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
  // analysis replaces them — the old boxes indexed into a different image.
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
    setMessage({ kind: 'info', text: `已载入样片 ${file.name}，文件没有离开本机。` })
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
    setFrame(decoded.frame)
    setMessage({ kind: 'info', text: `已载入${name}（${decoded.frame.width}×${decoded.frame.height}），图片没有离开本机。` })
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
      setMessage({
        kind: 'error',
        text: `取帧失败（${result.reason}）：${result.detail ?? '未知原因'}`,
      })
      return
    }
    setFrame(result.frame)
    setMessage(null)
  }, [sampleKind])

  const step = (delta: number): void => {
    const video = videoRef.current
    if (!video) return
    const fps = profile.sampleFps > 0 ? profile.sampleFps : 30
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + delta / fps))
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
    if (!frame) {
      setMessage({ kind: 'warn', text: '先取一帧再验证。' })
      return
    }
    const result = recognizeFrame(
      // `recognizeFrame` names the buffer `data`; the grabber names it `pixels`.
      { data: frame.pixels, width: frame.width, height: frame.height },
      profile,
      compileTemplates(profile),
      { mediaTime: frame.mediaTime, wallTime: frame.wallTime, frameIndex: 0 },
      { segment: {} },
    )
    setRecognized(result)
    setMessage(
      result.outcome.status === 'success'
        ? {
            kind: 'info',
            text: `识别为 ${result.outcome.reading.text}（${result.outcome.reading.seconds}s，置信度 ${result.outcome.reading.confidence.toFixed(3)}）`,
          }
        : { kind: 'warn', text: `识别失败（${result.outcome.reason}）：${result.outcome.detail ?? ''}` },
    )
  }

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
      setMessage({ kind: 'info', text: unchanged ? '已保存到本机草稿. 尚未发布的修改仍需发布后才能应用到播放器.'
        : '已保存提交时的草稿, 当前还有未保存的修改.' })
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
        setMessage({ kind: 'info', text: unchanged ? `已发布为本机预设 ${submitted.id}。`
          : `已发布 ${submitted.id} 提交时的版本, 当前还有未发布的修改.` })
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
          text: `预设 ${profile.id} 已在别处被修改。`,
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
    setMessage({ kind: 'info', text: `已载入预设 ${id}。` })
  }

  const loadDraft = async (id: string): Promise<void> => {
    const revision = ++editRevision.current
    const document = ++documentRevision.current
    try {
      const found = await profileStore.get(id)
      if (!mounted.current || revision !== editRevision.current || document !== documentRevision.current) return
      if (!found) {
        setMessage({ kind: 'error', text: '草稿已不存在。' })
        void refreshLibrary()
        return
      }
      setProfile(found)
      setPublishedProfile(null)
      setEtag(undefined)
      setDirty(false)
      setMessage({ kind: 'info', text: `已载入草稿 ${id}。` })
    } catch {
      if (mounted.current && revision === editRevision.current && document === documentRevision.current)
        setMessage({ kind: 'error', text: '草稿读取失败, 当前编辑内容已保留.' })
    }
  }

  const importFile = async (file: File): Promise<void> => {
    const revision = ++editRevision.current
    const document = ++documentRevision.current
    try {
      const parsed = parseProfile(JSON.parse(await file.text()) as unknown)
      if (!mounted.current || revision !== editRevision.current || document !== documentRevision.current) return
      if (!parsed.profile) {
        setMessage({
          kind: 'error',
          text: `导入失败：${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}`,
        })
        return
      }
      setProfile(parsed.profile)
      setPublishedProfile(null)
      setEtag(undefined)
      setDirty(true)
      const warnings = parsed.issues.filter((issue) => issue.severity === 'warning')
      setMessage({
        kind: warnings.length ? 'warn' : 'info',
        text: warnings.length ? `已导入，注意：${warnings.map((issue) => issue.message).join('；')}` : '已导入配置。',
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
   * 返回播放器 is a real navigation, so an in-memory hand-off would not survive it. What
   * survives is the id in settings, and the player fetches the preset by that id — which
   * only works if this profile is on the server and unmodified since.
   */
  const applyToPlayer = (): void => {
    if (!readiness.ready) {
      setMessage({ kind: 'warn', text: `还缺少字符模板：${readiness.missing.join(' ')}` })
      return
    }
    if (!etag || !publishedCurrent || saving) {
      setMessage({
        kind: 'warn',
        text: '播放器按 ID 从本机读取识别场景，请先“发布到本机”再应用。',
      })
      return
    }
    session.setProfileForAll(profile)
    session.updateSettings({ profileId: profile.id })
    setMessage({ kind: 'info', text: `已设为播放器的识别场景（${profile.id}），可以回去试自动同步了。` })
  }

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div>
          <h1>配置编辑器</h1>
          <p className="hint">
            {profile.id} · {readiness.sampleCount} 个样本
            {readiness.ready ? ' · 可用于识别' : ` · 缺 ${readiness.missing.join(' ')}`}
            {dirty ? ' · 未保存' : ''}
            {!publishedCurrent ? ' · 尚有未发布内容' : ''}
          </p>
        </div>
        <div className="admin-header-actions">
          <button type="button" className="ghost" onClick={applyToPlayer}>
            应用到播放器
          </button>
          <a className="ghost" href="/">
            返回播放器
          </a>
        </div>
      </header>

      {message ? (
        <div className={`admin-message is-${message.kind}`} role={message.conflict ? 'alert' : 'status'}>
          <span>{message.text}</span>
          {message.conflict ? (
            <span className="admin-message-actions">
              <button type="button" className="small" onClick={() => void loadPreset(profile.id)}>
                载入对方版本（放弃本次修改）
              </button>
              {message.conflict.currentEtag ? (
                <button type="button" className="small danger" disabled={saving !== null} onClick={() => void publish(message.conflict?.currentEtag)}>
                  用我的版本覆盖
                </button>
              ) : null}
            </span>
          ) : null}
          <button type="button" className="icon-button" onClick={() => setMessage(null)} aria-label="关闭提示">
            ×
          </button>
        </div>
      ) : null}

      <div className="admin-columns">
        <LibraryColumn
          profile={profile}
          presets={presets}
          drafts={drafts}
          onPatch={patch}
          onLoadPreset={loadPreset}
          onLoadDraft={loadDraft}
          onDeleteDraft={async (id) => {
            await profileStore.remove(id)
            void refreshLibrary()
          }}
          onNew={() => {
            ++editRevision.current
            ++documentRevision.current
            setProfile(createEmptyProfile())
            setPublishedProfile(null)
            setEtag(undefined)
            setDirty(false)
            setMessage({ kind: 'info', text: '已新建空白配置。' })
          }}
          onImport={importFile}
          onExport={exportFile}
          onSaveDraft={saveDraft}
          onPublish={() => publish()}
          saving={saving}
        />

        <section className="admin-stage-column">
          <div className="stage-toolbar">
            <label className="file-button">
              选择样片
              <input
                type="file"
                accept="video/*"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) openSample(file)
                  event.target.value = ''
                }}
              />
            </label>
            <label className="file-button">
              选择截图
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void openScreenshot(file, 'file')
                  event.target.value = ''
                }}
              />
            </label>
            <span className="stage-toolbar-hint">也可直接 Ctrl+V 粘贴截图</span>
            <span className="stage-toolbar-spacer" />
            <button type="button" onClick={() => step(-1)} disabled={!sampleUrl || sampleKind === 'image'}>
              上一帧
            </button>
            <button type="button" onClick={() => step(1)} disabled={!sampleUrl || sampleKind === 'image'}>
              下一帧
            </button>
            <button type="button" className="primary" onClick={grab} disabled={!sampleUrl || sampleKind === 'image'}>
              取当前帧
            </button>
          </div>

          <div className="admin-stage" ref={stageRef}>
            {sampleUrl && sampleKind === 'image' ? (
              <>
                <img src={sampleUrl} className="admin-video" alt={sampleName} draggable={false} />
                <RoiWindow
                  roi={profile.roi}
                  onChange={setRoi}
                  videoWidth={videoSize.width}
                  videoHeight={videoSize.height}
                  hostRef={stageRef}
                />
              </>
            ) : sampleUrl ? (
              <>
                <video
                  ref={videoRef}
                  src={sampleUrl}
                  className="admin-video"
                  controls={false}
                  playsInline
                  muted
                  onLoadedMetadata={(event) => {
                    const video = event.currentTarget
                    setVideoSize({ width: video.videoWidth, height: video.videoHeight })
                    setDuration(Number.isFinite(video.duration) ? video.duration : 0)
                  }}
                  onTimeUpdate={(event) => setMediaTime(event.currentTarget.currentTime)}
                  onSeeked={(event) => {
                    setMediaTime(event.currentTarget.currentTime)
                    // A seek is the usual way to reach the frame you want; grabbing right
                    // after it saves a click and guarantees the preview matches the picture.
                    grab()
                  }}
                />
                <RoiWindow
                  roi={profile.roi}
                  onChange={setRoi}
                  videoWidth={videoSize.width}
                  videoHeight={videoSize.height}
                  hostRef={stageRef}
                />
              </>
            ) : (
              <p className="stage-empty">选一段本地录像或一张截图作为样片，也可以直接粘贴截图。文件只在本机解码，不会上传。</p>
            )}
          </div>

          <div className="stage-timeline">
            <Slider
              label="样片进度"
              min={0}
              max={Math.max(0.1, duration)}
              step={0.02}
              value={Math.min(mediaTime, duration || mediaTime)}
              disabled={!sampleUrl || sampleKind === 'image'}
              onInput={(value) => {
                setMediaTime(value)
                const video = videoRef.current
                if (video) video.currentTime = value
              }}
              formatValue={(value) => `${value.toFixed(2)}s`}
            />
            <div className="timeline-readout">
              <button
                type="button"
                onClick={() => {
                  const video = videoRef.current
                  if (!video) return
                  if (video.paused) void video.play().catch(() => undefined)
                  else video.pause()
                }}
                disabled={!sampleUrl || sampleKind === 'image'}
              >
                播放 / 暂停
              </button>
              <span>
                {mediaTime.toFixed(2)}s / {duration ? `${duration.toFixed(2)}s` : '—'}
              </span>
              <span>
                {videoSize.width}×{videoSize.height}
              </span>
            </div>
          </div>

          <RoiFields roi={profile.roi} onChange={setRoi} videoSize={videoSize} />
        </section>

        <section className="admin-inspect-column">
          <PreprocessPanel profile={profile} onPatch={patch} inkRatio={analysis?.inkRatio ?? 0} />

          <div className="panel-block">
            <h2>裁切与二值化</h2>
            {analysis ? (
              <div className="preview-pair">
                <figure>
                  <canvas ref={grayCanvasRef} className="preview-canvas" />
                  <figcaption>灰度裁切</figcaption>
                </figure>
                <figure>
                  <div className="binary-wrap">
                    <canvas ref={binaryCanvasRef} className="preview-canvas" />
                    {boxes.map((box, index) => (
                      <button
                        type="button"
                        key={`${box.x}-${box.y}-${index}`}
                        className={`glyph-box${index === selected ? ' is-selected' : ''}`}
                        style={{
                          left: `${(box.x / analysis.binary.width) * 100}%`,
                          top: `${(box.y / analysis.binary.height) * 100}%`,
                          width: `${(box.width / analysis.binary.width) * 100}%`,
                          height: `${(box.height / analysis.binary.height) * 100}%`,
                        }}
                        onClick={() => setSelected(index)}
                        aria-label={`字符 ${index + 1}，${box.width}×${box.height}`}
                      />
                    ))}
                  </div>
                  <figcaption>
                    二值化 · {boxes.length} 个字符 · 墨迹 {(analysis.inkRatio * 100).toFixed(1)}%
                  </figcaption>
                </figure>
              </div>
            ) : (
              <p className="hint">取一帧后这里会显示识别区域的裁切、二值化和字符切分结果。</p>
            )}
          </div>

          {analysis ? (
            <SegmentEditor
              boxes={boxes}
              selected={selected}
              bounds={{ width: analysis.binary.width, height: analysis.binary.height }}
              onSelect={setSelected}
              onBoxes={setBoxes}
              onAssign={assign}
              onVerify={verifyFrame}
              recognized={recognized}
            />
          ) : null}

          <TemplateLibrary profile={profile} onRemove={removeSample} />
        </section>
      </div>
    </div>
  )
}

function LibraryColumn({
  profile,
  presets,
  drafts,
  onPatch,
  onLoadPreset,
  onLoadDraft,
  onDeleteDraft,
  onNew,
  onImport,
  onExport,
  onSaveDraft,
  onPublish,
  saving,
}: {
  profile: RecognitionProfile
  presets: PresetSummary[]
  drafts: StoredProfile[]
  onPatch: (update: Partial<RecognitionProfile>) => void
  onLoadPreset: (id: string) => Promise<void>
  onLoadDraft: (id: string) => Promise<void>
  onDeleteDraft: (id: string) => Promise<void>
  onNew: () => void
  onImport: (file: File) => Promise<void>
  onExport: () => void
  onSaveDraft: () => Promise<void>
  onPublish: () => Promise<void>
  saving: 'draft' | 'publish' | null
}): React.ReactNode {
  return (
    <section className="admin-library-column">
      <div className="panel-block">
        <h2>配置</h2>
        <label className="field">
          <span>标识</span>
          <input
            value={profile.id}
            onChange={(event) => onPatch({ id: event.target.value })}
            placeholder="cs2/iem"
            spellCheck={false}
          />
        </label>
        <p className="hint">小写字母、数字和斜线，例如 cs2/iem。发布时作为预设文件名。</p>
        <label className="field">
          <span>名称</span>
          <input value={profile.name} onChange={(event) => onPatch({ name: event.target.value })} />
        </label>
        <label className="field">
          <span>备注</span>
          <textarea
            value={profile.notes ?? ''}
            rows={2}
            onChange={(event) => onPatch({ notes: event.target.value })}
            placeholder="哪场比赛的画面、计时器在什么位置"
          />
        </label>
      </div>

      <div className="panel-block">
        <h2>识别参数</h2>
        <DropUp
          label="计时格式"
          value={profile.clockFormat}
          options={CLOCK_FORMAT_OPTIONS}
          onChange={(clockFormat) => onPatch({ clockFormat })}
          align="left"
        />
        <Slider
          label="识别窗口"
          min={1}
          max={6}
          step={1}
          value={profile.detectWindowSeconds}
          onInput={(detectWindowSeconds) => onPatch({ detectWindowSeconds })}
          formatValue={(value) => `${value}s`}
        />
        <Slider
          label="采样帧率"
          min={5}
          max={60}
          step={5}
          value={profile.sampleFps}
          onInput={(sampleFps) => onPatch({ sampleFps })}
          formatValue={(value) => `${value} fps`}
        />
        <Slider
          label="匹配阈值"
          min={0.5}
          max={0.99}
          step={0.01}
          value={profile.matchThreshold}
          onInput={(matchThreshold) => onPatch({ matchThreshold })}
          formatValue={(value) => value.toFixed(2)}
        />
        <p className="hint">阈值是最弱那个字符的得分下限。调高会漏掉一些帧，调低会读错。</p>
      </div>

      <div className="panel-block">
        <h2>预设库</h2>
        {presets.length === 0 ? (
          <p className="hint">本机还没有预设。</p>
        ) : (
          <ul className="library-list">
            {presets.map((preset) => (
              <li key={preset.id}>
                <button type="button" className="library-item" onClick={() => void onLoadPreset(preset.id)}>
                  <strong>{preset.name}</strong>
                  <span>
                    {preset.id} · {preset.templateChars} 个字符
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <h3>本机草稿</h3>
        {drafts.length === 0 ? (
          <p className="hint">还没有草稿。草稿保存在这台机器的浏览器里。</p>
        ) : (
          <ul className="library-list">
            {drafts.map((draft) => (
              <li key={draft.id}>
                <button type="button" className="library-item" onClick={() => void onLoadDraft(draft.id)}>
                  <strong>{draft.profile.name}</strong>
                  <span>{new Date(draft.updatedAt).toLocaleString()}</span>
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => void onDeleteDraft(draft.id)}
                  aria-label={`删除草稿 ${draft.id}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel-block">
        <h2>存取</h2>
        <div className="button-row">
          <button type="button" onClick={onNew}>
            新建
          </button>
          <label className="file-button">
            导入 JSON
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void onImport(file)
                event.target.value = ''
              }}
            />
          </label>
          <button type="button" onClick={onExport}>
            导出 JSON
          </button>
        </div>
        <div className="button-row">
          <button type="button" disabled={saving !== null} onClick={() => void onSaveDraft()}>
            {saving === 'draft' ? '正在保存草稿...' : '存为草稿'}
          </button>
          <button type="button" className="primary" disabled={saving !== null} onClick={() => void onPublish()}>
            {saving === 'publish' ? '正在发布...' : '发布到本机'}
          </button>
        </div>
      </div>
    </section>
  )
}

function RoiFields({
  roi,
  onChange,
  videoSize,
}: {
  roi: RoiRect
  onChange: (roi: RoiRect) => void
  videoSize: { width: number; height: number }
}): React.ReactNode {
  const fields: { key: keyof RoiRect; label: string; span: number }[] = [
    { key: 'x', label: 'X', span: videoSize.width },
    { key: 'y', label: 'Y', span: videoSize.height },
    { key: 'w', label: '宽', span: videoSize.width },
    { key: 'h', label: '高', span: videoSize.height },
  ]
  return (
    <div className="roi-fields">
      {fields.map((field) => (
        <label key={field.key} className="roi-field">
          <span>{field.label}</span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.001}
            value={roi[field.key].toFixed(4)}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (Number.isFinite(next)) onChange({ ...roi, [field.key]: next })
            }}
          />
          {/* Fractions are what gets stored; pixels are what the user can see on screen. */}
          <em>{field.span ? `${Math.round(roi[field.key] * field.span)}px` : '—'}</em>
        </label>
      ))}
    </div>
  )
}

function PreprocessPanel({
  profile,
  onPatch,
  inkRatio: ratio,
}: {
  profile: RecognitionProfile
  onPatch: (update: Partial<RecognitionProfile>) => void
  inkRatio: number
}): React.ReactNode {
  const set = (update: Partial<RecognitionProfile['preprocess']>): void =>
    onPatch({ preprocess: { ...profile.preprocess, ...update } })
  return (
    <div className="panel-block">
      <h2>预处理</h2>
      <Slider
        label="对比度"
        min={0.5}
        max={3}
        step={0.1}
        value={profile.preprocess.scale}
        onInput={(scale) => set({ scale })}
        formatValue={(value) => `${value.toFixed(1)}×`}
      />
      <Slider
        label="二值化阈值"
        min={0}
        max={255}
        step={1}
        value={profile.preprocess.threshold}
        onInput={(threshold) => set({ threshold })}
      />
      <Toggle
        checked={profile.preprocess.invert}
        onChange={(invert) => set({ invert })}
        label="反相"
        hint="浅底深字时打开, 深底亮字时保持关闭, 让笔画显示为白色"
      />
      <div className="button-row">
        <button type="button" onClick={() => set({ ...DEFAULT_PREPROCESS })}>
          恢复默认
        </button>
        <span className="hint">当前墨迹比例 {(ratio * 100).toFixed(1)}%</span>
      </div>
      <p className="hint">目标是数字笔画连成整块白色、背景全黑。比例低于 0.4% 或高于 85% 的帧会被识别判为无效。</p>
    </div>
  )
}

/**
 * Glyph segmentation editing.
 *
 * Automatic segmentation is a column-projection cut, which fails predictably: touching
 * digits become one box, a colon becomes two, and a scoreboard's separator line becomes a
 * box of its own. Rather than adding heuristics for each case, the editor lets the user fix
 * the boxes directly — merge, split, drop, or nudge an edge — and then teaches from those.
 */
function SegmentEditor({
  boxes,
  selected,
  bounds,
  onSelect,
  onBoxes,
  onAssign,
  onVerify,
  recognized,
}: {
  boxes: GlyphBox[]
  selected: number
  bounds: { width: number; height: number }
  onSelect: (index: number) => void
  onBoxes: (boxes: GlyphBox[]) => void
  onAssign: (char: ClockChar) => void
  onVerify: () => void
  recognized: RecognizeResult | null
}): React.ReactNode {
  const active = selected >= 0 ? boxes[selected] : undefined
  return (
    <div className="panel-block">
      <h2>字符切分</h2>
      <div className="glyph-strip">
        {boxes.map((box, index) => (
          <button
            type="button"
            key={`${box.x}-${index}`}
            className={`glyph-chip${index === selected ? ' is-selected' : ''}`}
            onClick={() => onSelect(index)}
          >
            {index + 1}
          </button>
        ))}
        {boxes.length === 0 ? <span className="hint">没有切出字符，调一下阈值或识别区域。</span> : null}
      </div>

      {active ? (
        <>
          <div className="button-row">
            <button
              type="button"
              onClick={() => onBoxes(mergeGlyphBoxes(boxes, selected, selected + 1))}
              disabled={selected + 1 >= boxes.length}
            >
              与右侧合并
            </button>
            <button
              type="button"
              onClick={() => onBoxes(splitGlyphBox(boxes, selected, active.x + Math.floor(active.width / 2)))}
              disabled={active.width < 4}
            >
              居中拆分
            </button>
            <button type="button" onClick={() => onBoxes(excludeGlyphBox(boxes, selected))}>
              排除
            </button>
          </div>
          <div className="edge-grid">
            {(['left', 'right', 'top', 'bottom'] as const).map((edge) => (
              <div key={edge} className="edge-row">
                <span>{EDGE_TEXT[edge]}</span>
                <button
                  type="button"
                  onClick={() => onBoxes(adjustGlyphBox(boxes, selected, edge, -1, bounds))}
                  aria-label={`${EDGE_TEXT[edge]}减 1 像素`}
                >
                  −
                </button>
                <button
                  type="button"
                  onClick={() => onBoxes(adjustGlyphBox(boxes, selected, edge, 1, bounds))}
                  aria-label={`${EDGE_TEXT[edge]}加 1 像素`}
                >
                  +
                </button>
              </div>
            ))}
          </div>
          <p className="hint">
            选中第 {selected + 1} 个：{active.width}×{active.height}，墨迹 {active.ink} 像素
          </p>
          <div className="char-pad">
            {CLOCK_CHARS.map((char) => (
              <button type="button" key={char} className="char-key" onClick={() => onAssign(char)}>
                {char}
              </button>
            ))}
          </div>
          <p className="hint">点字符就把当前选中的框存成那个字符的样本，然后自动跳到下一个框。</p>
        </>
      ) : (
        <p className="hint">选一个字符框，再点下面的字符按钮把它存成模板样本。</p>
      )}

      <div className="button-row">
        <button type="button" className="primary" onClick={onVerify}>
          验证当前帧
        </button>
        {recognized ? (
          <span className={recognized.outcome.status === 'success' ? 'verify-ok' : 'verify-bad'}>
            {recognized.outcome.status === 'success'
              ? `${recognized.outcome.reading.text} · ${recognized.outcome.reading.confidence.toFixed(3)}`
              : recognized.outcome.reason}
          </span>
        ) : null}
      </div>
      {recognized?.debug ? (
        <ul className="match-list">
          {recognized.debug.matches.map((match, index) => (
            <li key={index}>
              <strong>{match.char ?? '?'}</strong>
              <span>得分 {match.score.toFixed(3)}</span>
              <span>次优 {match.runnerUpScore.toFixed(3)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

const EDGE_TEXT = { left: '左边', right: '右边', top: '上边', bottom: '下边' } as const

/** Stored samples, per character, as thumbnails so a bad one can be spotted and dropped. */
function TemplateLibrary({
  profile,
  onRemove,
}: {
  profile: RecognitionProfile
  onRemove: (char: ClockChar, id: string) => void
}): React.ReactNode {
  return (
    <div className="panel-block">
      <h2>字符模板</h2>
      <div className="template-grid">
        {CLOCK_CHARS.map((char) => {
          const samples = profile.templates[char] ?? []
          return (
            <div key={char} className={`template-cell${samples.length === 0 ? ' is-empty' : ''}`}>
              <header>
                <strong>{char}</strong>
                <span>{samples.length}</span>
              </header>
              <div className="template-samples">
                {samples.map((sample) => (
                  <button
                    type="button"
                    key={sample.id}
                    className="template-thumb"
                    title={`${sample.origin ?? '未知来源'}，点击删除`}
                    onClick={() => onRemove(char, sample.id)}
                  >
                    <SampleThumb data={sample.data} />
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      <p className="hint">同一个字符多存几个样本更稳：不同回合的渲染、压缩噪点都不完全一样。点缩略图可以删掉。</p>
    </div>
  )
}

function SampleThumb({ data }: { data: string }): React.ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    try {
      drawMask(canvasRef.current, {
        data: unpackBitmap(data, TEMPLATE_PIXELS),
        width: TEMPLATE_SIZE.width,
        height: TEMPLATE_SIZE.height,
      })
    } catch {
      // A corrupt sample draws nothing rather than taking the panel down.
    }
  }, [data])
  return <canvas ref={canvasRef} className="thumb-canvas" />
}

