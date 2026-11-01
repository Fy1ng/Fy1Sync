/**
 * The HUD style editor (`/admin`).
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
 * Preview, teaching and playback use the same Rust frame pipeline.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type ClockChar,
  type RoiRect,
} from '../../core/profileSchema'
import { createEmptyHudStylePack, parseHudStylePack, hudPackReadiness, HUD_FIELD_IDS, HUD_CUE_IDS, type HudStylePack } from '../../core/hudStylePack'
import { prepareHudCue, prepareHudGlyphs, recognizeHudFrame, type HudAnalysis, type HudFieldResult, type HudFrameResult } from '../../core/hudWasm'
import { FIELD_LABELS, fieldModel, fieldReadiness, patchField, sizeEmptyClock, type EditorClockModel } from './editorModel'
import { CUE_LABELS, cueModel, editorCue, isCueTarget, patchCue, type EditorTarget } from './cueModel'
import { CueSection, FrameStatePreview, StateRules } from './CueSection'
import { addLayout, editorVariant, generateScaledLayout, removeLayout, renameLayout } from './layoutModel'
import { LayoutSection } from './LayoutSection'
import type { GlyphBox } from '../../core/segmentation'
import { profileStore, type StoredProfile } from '../../core/profileStore'
import { apiClient, issuesFrom, type PresetSummary } from '../../app/apiClient'
import { FrameGrabber, FULL_FRAME_ROI, type GrabbedFrame } from '../../recognition/frameGrabber'
import { useSession } from '../../app/SessionContext'
import { routeLink } from '../../app/navigate'
import { Icon, Segmented, Switch } from '../kit'
import { drawGray, drawMask } from './framePipeline'
import { RoiWindow } from './RoiWindow'
import { EditorStage } from './EditorStage'
import { FrameStepper, presentAt } from './frameStep'
import { StretchSection } from './StretchSection'
import type { StretchSample } from './stretch'
import { decodeScreenshot, imageFromClipboard } from './screenshotSample'
import { FileMenu, LibraryMenu } from './library'
import { BinarizeSection, GlyphSection, ParamsSection, RegionSection, SampleSection } from './rail'
import { YouTubePanel, type YouTubeClipJob, type YouTubeSource, type YouTubeStill } from './YouTubePanel'
import { youtubeSource } from './youtubeSource'
import { useEditorProject } from './useEditorProject'
import { useCountdownTeaching } from './useCountdownTeaching'
import { AutoStepControl } from './AutoStepControl'
import { usePreprocessRecommendation } from './usePreprocessRecommendation'
import { useBatchValidation } from './useBatchValidation'
import { BatchValidationPanel } from './BatchValidationPanel'
import { waitValidationVideo } from './batchValidationRunner'
import '../studio.css'
import './editor.css'

interface Message {
  kind: 'info' | 'warn' | 'error'
  text: string
  /** Set when a publish lost an ETag race; the note then offers the two ways out. */
  conflict?: { currentEtag?: string }
}

const AUTO_GRAB_KEY = 'studio.editor.autoGrab'
/** 自动取帧 is on unless it was turned off; a blocked storage keeps it on. */
function readAutoGrab(): boolean {
  try { return window.localStorage.getItem(AUTO_GRAB_KEY) !== 'off' } catch { return true }
}

/** Only the trusted local app frame can invoke preset writes in main. */
export default function EditorPage(): React.ReactNode {
  const session = useSession()
  const [candidate] = useState(() => session.takeEditingCandidate())
  const [pack, setPack] = useState<HudStylePack>(() => candidate ?? createEmptyHudStylePack())
  const [selectedVariantId, setSelectedVariantId] = useState<string | undefined>(undefined)
  const variant = editorVariant(pack, selectedVariantId)
  const variantId = variant.id
  const adoptFootageSize = useRef(candidate === null)
  const [fieldId, setFieldId] = useState<EditorTarget>('clock')
  const cueId = isCueTarget(fieldId) ? fieldId : null
  const numericId = isCueTarget(fieldId) ? 'clock' : fieldId
  const profile = useMemo(() => isCueTarget(fieldId) ? cueModel(pack, fieldId, variantId) : fieldModel(pack, fieldId, variantId), [pack, fieldId, variantId])
  const activePack = useMemo(() => isCueTarget(fieldId) ? patchCue(pack, fieldId, {}, undefined, variantId)
    : variant.fields[fieldId] ? pack : patchField(pack, fieldId, {}, variantId), [pack, fieldId, variant, variantId])
  useEffect(() => session.clearEditingCandidate(), [session])
  const [etag, setEtag] = useState<string | undefined>(undefined)
  const [publishedProfile, setPublishedProfile] = useState<HudStylePack | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState<'draft' | 'publish' | null>(null)
  const saveInFlight = useRef(false)
  const mounted = useRef(false)
  const editRevision = useRef(0)
  const documentRevision = useRef(0)
  const libraryRevision = useRef(0)
  const profileRef = useRef(activePack)
  profileRef.current = activePack
  const publishedCurrent = useMemo(() => publishedProfile !== null && JSON.stringify(pack) === JSON.stringify(publishedProfile), [pack, publishedProfile])
  const [message, setMessage] = useState<Message | null>(null)
  const [presets, setPresets] = useState<PresetSummary[]>([])
  const [drafts, setDrafts] = useState<StoredProfile[]>([])

  const [sampleUrl, setSampleUrl] = useState('')
  /** A still screenshot replaces the video; the video controls do not apply to it. */
  const [sampleKind, setSampleKind] = useState<'video' | 'image'>('video')
  const [sampleName, setSampleName] = useState('')
  /** Where footage comes from: local files, or a YouTube recording browsed through main. */
  const [footage, setFootage] = useState<'local' | 'youtube'>('local')
  /** 自动取帧: take the frame playback stops on (a seek, a pause) without a click. */
  const [autoGrab, setAutoGrabState] = useState(readAutoGrab)
  const setAutoGrab = useCallback((on: boolean): void => {
    setAutoGrabState(on)
    try { window.localStorage.setItem(AUTO_GRAB_KEY, on ? 'on' : 'off') } catch { /* Kept for this window only. */ }
  }, [])
  const ytSource = useMemo<YouTubeSource | null>(() => youtubeSource(), [])
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 })
  const [mediaTime, setMediaTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [validationOpen, setValidationOpen] = useState(false)
  const validationReadOnly = useRef(false)
  validationReadOnly.current = validationOpen
  const validation = useBatchValidation({ source: sampleKind === 'video' ? sampleUrl : '', sourceName: sampleName, pack, duration })
  const reviewSeek = useRef<AbortController | null>(null)
  useEffect(() => () => reviewSeek.current?.abort(), [sampleUrl])

  const [frame, setFrame] = useState<GrabbedFrame | null>(null)
  const [boxes, setBoxes] = useState<GlyphBox[]>([])
  const [selected, setSelected] = useState(-1)
  const [recognized, setRecognized] = useState<HudFieldResult | null>(null)
  const [frameResult, setFrameResult] = useState<HudFrameResult | null>(null)
  const [playerFrameResult, setPlayerFrameResult] = useState<HudFrameResult | null>(null)
  const frameRef = useRef(frame)
  frameRef.current = frame

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const grabberRef = useRef(new FrameGrabber())
  /** Steps by the file's real frames; reset whenever a different file is opened. */
  const stepperRef = useRef<FrameStepper | null>(null)
  const stepping = useRef(false)
  /**
   * The media time of the frame on screen after the last step. `currentTime` stays where the
   * seek asked, which can sit anywhere inside that frame, so the next step starts from here.
   */
  const shownFrame = useRef<{ at: number; requested: number } | null>(null)
  const grayCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const binaryCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const objectUrlRef = useRef<string>('')
  const countdown = useCountdownTeaching({ pack: activePack, fieldId, variantId, source: sampleUrl, frame, boxes,
    video: videoRef, grabber: grabberRef, revision: editRevision, documentRevision: documentRevision.current,
    onFrame: setFrame, onSelect: setSelected, onMessage: setMessage, onPack: updated => {
      ++editRevision.current
      setPack(updated)
      setDirty(true)
    } })

  const openVideo = useCallback((url: string, name: string): void => {
    if (validationReadOnly.current) return
    countdown.reset()
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    objectUrlRef.current = ''
    stepperRef.current = null
    shownFrame.current = null
    setSampleKind('video')
    setSampleUrl(url)
    setSampleName(name)
    setFrame(null)
    setMediaTime(0)
    setDuration(0)
    setPlaying(false)
    setFootage('local')
    setMessage(null)
  }, [countdown.reset])
  const project = useEditorProject({ pack, variantId, hasCandidate: candidate !== null, open: openVideo,
    restorePack: (saved, id) => {
      adoptFootageSize.current = false
      setPack(saved)
      setSelectedVariantId(id)
      setDirty(true)
    } })

  const readiness = useMemo(() => fieldReadiness(pack, numericId, variantId), [pack, numericId, variantId])
  const clockReadiness = useMemo(() => hudPackReadiness(pack, variantId), [pack, variantId])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; documentRevision.current++; libraryRevision.current++ }
  }, [])

  const [analysis, setAnalysis] = useState<HudAnalysis | null>(null)
  const analysisKey = JSON.stringify([variantId, fieldId, profile.enabled, variant.nativeSize, profile.roi, profile.preprocess, profile.segment])
  useEffect(() => {
    if (!adoptFootageSize.current || !videoSize.width || !videoSize.height) return
    setPack(current => sizeEmptyClock(current, videoSize.width, videoSize.height))
  }, [videoSize.width, videoSize.height])
  useEffect(() => {
    let active = true
    setAnalysis(null)
    const prepared = !frame || !profile.enabled ? null : cueId ? prepareHudCue(frame, profileRef.current, cueId, variantId).then(result => ({ ...result,
      boxes: [], projection: [], normalized: [], bitmaps: [], inkRatio: 0 }))
      : prepareHudGlyphs(frame, profileRef.current, variantId, undefined, numericId)
    if (prepared) void prepared.then(result => {
      if (active) setAnalysis(result)
    }).catch(error => {
      if (active) setMessage({ kind: 'error', text: `画面处理失败: ${error instanceof Error ? error.message : String(error)}` })
    })
    return () => { active = false }
  }, [frame, analysisKey, cueId, numericId, variantId, profile.enabled])

  useEffect(() => {
    let active = true
    setFrameResult(null)
    if (frame) void recognizeHudFrame(frame, activePack, variantId).then(result => {
      if (active) setFrameResult(result)
    }).catch(error => {
      if (active) setMessage({ kind: 'error', text: `状态预览失败: ${String(error)}` })
    })
    return () => { active = false }
  }, [frame, activePack, variantId])

  useEffect(() => {
    let active = true
    setPlayerFrameResult(null)
    if (frame) void recognizeHudFrame(frame, pack).then(result => {
      if (active) setPlayerFrameResult(result)
    }).catch(error => {
      if (active) setMessage({ kind: 'error', text: `布局预览失败: ${String(error)}` })
    })
    return () => { active = false }
  }, [frame, pack])

  // Manual box edits live in their own state so they survive a re-render, but a fresh
  // analysis replaces them: the old boxes indexed into a different image. Boxes run left to
  // right, so the first one is selected for the character buttons.
  useEffect(() => {
    setBoxes(analysis ? analysis.boxes : [])
    setSelected(analysis?.boxes.length ? 0 : -1)
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
    return apiClient.subscribeFeatures(event => {
      if (event.topic === 'stylepacks-changed') void refreshLibrary()
    })
  }, [refreshLibrary])

  // Object URLs are revoked on replacement and on unmount; a leaked one pins the whole
  // decoded file in memory for the lifetime of the document.
  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    },
    [],
  )

  const patch = useCallback((update: Partial<EditorClockModel>) => {
    if (validationReadOnly.current) return
    ++editRevision.current
    if (update.id !== undefined && update.id !== profileRef.current.id) {
      ++documentRevision.current
      setEtag(undefined)
      setPublishedProfile(null)
    }
    setPack(current => isCueTarget(fieldId) ? patchCue(current, fieldId, update, undefined, variantId) : patchField(current, fieldId, update, variantId))
    setDirty(true)
  }, [fieldId, variantId])

  const preprocessing = usePreprocessRecommendation({ frame, pack: activePack, variantId, target: fieldId,
    revision: editRevision, disabled: countdown.busy || !profile.enabled, apply: preprocess => patch({ preprocess }), message: setMessage })
  const patchPreprocess = (update: Partial<EditorClockModel>): void => {
    patch(update)
    if (update.preprocess && JSON.stringify(update.preprocess) !== JSON.stringify(profile.preprocess)) {
      const hasSamples = cueId ? editorCue(pack, cueId, variantId).templates.length > 0 : readiness.sampleCount > 0
      if (hasSamples) setMessage({ kind: 'warn', text: '预处理参数已改变, 原样本已保留. 请重新验证当前帧, 必要时重新取样, 不要直接继续自动写入.' })
    }
  }

  const toggleField = (enabled: boolean): void => {
    if (countdown.autoRunning) countdown.stopAuto()
    patch({ enabled })
    const label = cueId ? CUE_LABELS[cueId] : FIELD_LABELS[numericId]
    setMessage({ kind: 'info', text: enabled ? `${label}已启用` : `${label}已关闭, 区域, 参数和样本已保留, 不再参与识别` })
  }

  const changeField = (next: EditorTarget): void => {
    ++editRevision.current
    setAnalysis(null)
    setRecognized(null)
    setBoxes([])
    setSelected(-1)
    setFieldId(next)
  }

  const changeLayout = (id: string): void => {
    ++editRevision.current
    setAnalysis(null)
    setFrameResult(null)
    setRecognized(null)
    setBoxes([])
    setSelected(-1)
    setSelectedVariantId(id)
  }

  const createLayout = (): void => {
    if (!frame) return
    const added = addLayout(pack, variantId, frame)
    adoptFootageSize.current = false
    setPack(added.pack)
    changeLayout(added.id)
    setDirty(true)
  }

  const generateLayout = (height: 1440 | 1080): void => {
    try {
      const added = generateScaledLayout(pack, variantId, height)
      adoptFootageSize.current = false
      setPack(added.pack)
      changeLayout(added.id)
      setDirty(true)
    } catch (error) { setMessage({ kind: 'error', text: String(error) }) }
  }

  const editLayoutId = (id: string): string | null => {
    const renamed = renameLayout(pack, variantId, id)
    if (renamed.error) return renamed.error
    setPack(renamed.pack)
    changeLayout(id)
    setDirty(true)
    return null
  }

  const deleteLayout = (): void => {
    const updated = removeLayout(pack, variantId)
    if (updated === pack) return
    setPack(updated)
    changeLayout(updated.variants[0]!.id)
    setDirty(true)
  }

  const setRoi = useCallback((roi: RoiRect) => patch({ roi }), [patch])

  const openScreenshot = useCallback(async (file: File, origin: 'file' | 'paste'): Promise<void> => {
    if (validationReadOnly.current) return
    const decoded = await decodeScreenshot(file)
    if (validationReadOnly.current) return
    if (!decoded.ok) {
      setMessage({ kind: 'error', text: decoded.message })
      return
    }
    countdown.reset()
    project.clear()
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
  }, [project.clear, countdown.reset])

  /**
   * A YouTube still is a screenshot like any other: the frame to sample from. One taken by
   * 自动取帧 leaves the player on show, so the recording can be paused and stepped again.
   */
  const openStill = useCallback(async (still: YouTubeStill, auto = false): Promise<void> => {
    if (validationReadOnly.current) return
    const canvas = document.createElement('canvas')
    canvas.width = still.frame.width
    canvas.height = still.frame.height
    canvas.getContext('2d')?.putImageData(new ImageData(still.frame.pixels as Uint8ClampedArray<ArrayBuffer>, still.frame.width, still.frame.height), 0, 0)
    // A blob, not a data URL: a 4K PNG as a data URL is a 13 MB string, twice as slow to show.
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob || validationReadOnly.current) return
    countdown.reset()
    project.clear()
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    const url = URL.createObjectURL(blob)
    objectUrlRef.current = url
    const name = `YouTube ${still.videoId} @ ${Math.round(still.approxTime)}s`
    setSampleKind('image')
    setSampleUrl(url)
    setSampleName(name)
    setVideoSize({ width: still.frame.width, height: still.frame.height })
    setMediaTime(still.approxTime)
    setDuration(0)
    setPlaying(false)
    setFrame(still.frame)
    if (!auto) setFootage('local')
    setMessage(still.native
      ? { kind: 'info', text: `已截取 ${still.frame.width}×${still.frame.height} 原尺寸画面` }
      : { kind: 'warn', text: `截到的画面不是原尺寸（${still.frame.width}×${still.frame.height}），不建议当样本` })
  }, [project.clear, countdown.reset])

  /** A downloaded stretch opens as footage, the same as a chosen file. */
  const openClip = useCallback((job: YouTubeClipJob): void => {
    if (!job.mediaUrl || !job.assetId || validationReadOnly.current) return
    const name = `${job.title || job.videoId} ${Math.round(job.startSeconds)}-${Math.round(job.endSeconds)}s`
    project.remember({ id: `youtube-${job.assetId}`, kind: 'youtube', assetId: job.assetId, name, match: '', purpose: 'making' })
    openVideo(job.mediaUrl, name)
    setMessage({ kind: 'info', text: '已打开下载的片段' })
  }, [openVideo, project.remember])

  // Ctrl+V anywhere on the editor, except into a text field, which keeps its own paste.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      if (validationReadOnly.current) return
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
    if (!video || sampleKind === 'image' || countdown.isBusy()) return
    // The whole frame is grabbed, not just the ROI: the editor re-crops on every ROI
    // change, and re-grabbing per pixel of drag would stall on a paused decoder.
    const result = grabberRef.current.grab(video, FULL_FRAME_ROI, video.currentTime)
    if (!result.ok) {
      setMessage({ kind: 'error', text: `取帧失败（${result.reason}）：${result.detail ?? '未知原因'}` })
      return
    }
    setFrame(result.frame)
    setMessage(null)
  }, [sampleKind, countdown.isBusy])

  const step = (delta: -1 | 1): void => {
    const video = videoRef.current
    // A held arrow key repeats faster than a seek lands; each press waits for the last.
    if (!video || stepping.current || countdown.isBusy() || validationReadOnly.current) return
    video.pause()
    stepperRef.current ??= new FrameStepper(presentAt(video))
    stepping.current = true
    // Still on the frame the last step reached (nothing else moved the video): start from it.
    const last = shownFrame.current
    const from = last && Math.abs(video.currentTime - last.requested) < 1e-6 ? last.at : video.currentTime
    void stepperRef.current.step(from, delta, video.duration)
      .then((at) => { shownFrame.current = { at, requested: video.currentTime } })
      .finally(() => { stepping.current = false })
  }

  /** A clock reading opts whole-second jumps into teaching the destination frame. */
  const jump = (seconds: number): void => {
    const video = videoRef.current
    if (!video || stepping.current || countdown.isBusy() || validationReadOnly.current) return
    if (countdown.jump(seconds)) return
    video.pause()
    const end = Number.isFinite(video.duration) ? video.duration : video.currentTime
    const target = Math.max(0, Math.min(end, video.currentTime + seconds))
    setMediaTime(target)
    video.currentTime = target
  }

  const togglePlay = (): void => {
    const video = videoRef.current
    if (!video || countdown.isBusy()) return
    if (video.paused) void video.play().catch(() => undefined)
    else video.pause()
  }

  const assign = (char: ClockChar): void => { if (analysis && !validationReadOnly.current) void countdown.assign(char, selected) }

  /** Reviewed samples from a scanned stretch, each glyph once. */
  const saveStretch = (samples: StretchSample[]): void => {
    if (!profile.enabled) return
    const templates = { ...profile.templates }
    const stamp = Date.now()
    samples.forEach((sample, index) => {
      templates[sample.char] = [...(templates[sample.char] ?? []), {
        id: `${sample.char}-${stamp.toString(36)}-${index.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        data: sample.data, createdAt: stamp, origin: `${sampleName || '样片'} @ ${sample.at.toFixed(2)}s`,
      }]
    })
    patch({ templates })
    setMessage({ kind: 'info', text: `已从这一段存入 ${samples.length} 个字符样本（相同的字形只存一次）` })
  }

  const removeSample = (char: ClockChar, id: string): void => {
    const kept = (profile.templates[char] ?? []).filter((sample) => sample.id !== id)
    const templates = { ...profile.templates }
    if (kept.length > 0) templates[char] = kept
    else delete templates[char]
    patch({ templates })
  }

  const verifyFrame = async (): Promise<void> => {
    if (!frame || !profile.enabled) return
    const revision = editRevision.current
    try {
      const result = await recognizeHudFrame(frame, activePack, variantId)
      if (mounted.current && revision === editRevision.current && frameRef.current === frame) {
        setRecognized(result.fields[numericId])
        setFrameResult(result)
      }
    } catch (error) { setMessage({ kind: 'error', text: `验证失败: ${String(error)}` }) }
  }

  const saveCue = async (): Promise<void> => {
    if (!frame || !cueId || !profile.enabled) return
    const revision = editRevision.current
    try {
      const sample = await prepareHudCue(frame, activePack, cueId, variantId)
      if (!mounted.current || revision !== editRevision.current || frameRef.current !== frame) return
      const updated = patchCue(pack, cueId, {}, sample, variantId)
      const validated = parseHudStylePack(updated)
      if (!validated.pack) {
        setMessage({ kind: 'error', text: `模板无法保存: ${validated.issues.map(issue => issue.message).join('; ')}` })
        return
      }
      ++editRevision.current
      setPack(updated)
      setDirty(true)
      setMessage({ kind: 'info', text: `已把${CUE_LABELS[cueId]}存为模板` })
    } catch (error) { setMessage({ kind: 'error', text: `取样失败: ${String(error)}` }) }
  }

  // Ctrl+Z is scoped to this editor; editable text keeps its native text undo.
  const keys = useRef({ step, jump, togglePlay, undo: countdown.undo, video: false })
  keys.current = { step, jump, togglePlay, undo: countdown.undo, video: sampleUrl !== '' && sampleKind === 'video' }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (validationReadOnly.current) return
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('textarea, select, [contenteditable="true"], .pop') || (target instanceof HTMLInputElement && target.type !== 'range')) return
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'z' && keys.current.undo) {
        event.preventDefault()
        keys.current.undo()
        return
      }
      const arrow = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
      const jumpBy = arrow && !event.altKey && !event.metaKey ? (event.ctrlKey ? 10 : event.shiftKey ? 1 : 0) : 0
      if (!jumpBy && (event.ctrlKey || event.metaKey || event.altKey)) return
      if (!keys.current.video || target.closest('button, input, [role="group"]')) return
      if (jumpBy) {
        event.preventDefault()
        keys.current.jump(arrow * jumpBy)
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
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
    const submitted = pack
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
    const submitted = pack
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
    adoptFootageSize.current = false
    setPack(result.value.profile)
    setSelectedVariantId(undefined)
    setFieldId('clock')
    setPublishedProfile(result.value.profile)
    // Publishing an edited cloud asset creates a local override, never a cloud write.
    setEtag(result.value.source === 'cloud' ? undefined : result.value.etag)
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
      adoptFootageSize.current = false
      setPack(found)
      setSelectedVariantId(undefined)
      setFieldId('clock')
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
    adoptFootageSize.current = true
    setPack(createEmptyHudStylePack(undefined, undefined, videoSize.width && videoSize.height ? videoSize : undefined))
    setSelectedVariantId(undefined)
    setFieldId('clock')
    setPublishedProfile(null)
    setEtag(undefined)
    setDirty(false)
    setMessage({ kind: 'info', text: '已新建空白样式' })
  }

  const importFile = async (file: File): Promise<void> => {
    const revision = ++editRevision.current
    const document = ++documentRevision.current
    try {
      const parsed = parseHudStylePack(JSON.parse(await file.text()) as unknown)
      if (!mounted.current || revision !== editRevision.current || document !== documentRevision.current) return
      if (!parsed.pack) {
        setMessage({ kind: 'error', text: `导入失败：${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}` })
        return
      }
      adoptFootageSize.current = false
      setPack(parsed.pack)
      setSelectedVariantId(undefined)
      setFieldId('clock')
      setPublishedProfile(null)
      setEtag(undefined)
      setDirty(true)
      setMessage({ kind: 'info', text: '已导入' })
    } catch (error) {
      if (mounted.current && revision === editRevision.current && document === documentRevision.current)
        setMessage({ kind: 'error', text: `导入失败：${error instanceof Error ? error.message : String(error)}` })
    }
  }

  const exportFile = (): void => {
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' })
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
    if (variant.fields.clock?.enabled === false) {
      setMessage({ kind: 'warn', text: '倒计时字段已关闭, 请启用后再应用到播放器' })
      return
    }
    if (!clockReadiness.ready) {
      setMessage({ kind: 'warn', text: `还缺少字符样本：${clockReadiness.missing.join(' ')}` })
      return
    }
    if (!etag || !publishedCurrent || saving) {
      setMessage({ kind: 'warn', text: '播放器读取的是已发布的预设，请先发布到本机再应用' })
      return
    }
    session.setProfileForAll(pack)
    session.updateSettings({ profileId: profile.id })
    setMessage({ kind: 'info', text: `已设为播放器的倒计时样式（${profile.id}）` })
  }

  const state = dirty ? 'dirty' : publishedCurrent ? 'published' : 'unpublished'
  const video = sampleUrl !== '' && sampleKind === 'video'

  const openValidation = (): void => {
    if (!video || countdown.isBusy() || preprocessing.busy || stepping.current || saving !== null) return
    videoRef.current?.pause()
    setFootage('local')
    setMessage(null)
    setValidationOpen(true)
  }
  const jumpToValidationFrame = (at: number): void => {
    const node = videoRef.current
    if (!node || validation.state.phase === 'running') return
    reviewSeek.current?.abort()
    const controller = new AbortController()
    reviewSeek.current = controller
    node.pause()
    void waitValidationVideo(node, at, controller.signal).then(() => {
      if (!controller.signal.aborted) {
        grab()
        node.closest('.editor-stage')?.scrollIntoView({ block: 'nearest' })
      }
    }).catch(error => {
      if (!controller.signal.aborted) setMessage({ kind: 'error', text: `跳转失败: ${error instanceof Error ? error.message : String(error)}` })
    }).finally(() => { if (reviewSeek.current === controller) reviewSeek.current = null })
  }

  return (
    <div className="studio editor" inert={!project.ready}>
      <header className="editor-bar" inert={validationOpen}>
        <a className="icon-btn" {...routeLink('/')} aria-label="返回播放器" title="返回播放器"><Icon name="back" /></a>
        <div className="editor-title">
          <input className="editor-name" value={profile.name} aria-label="名称" spellCheck={false}
            onChange={(event) => patch({ name: event.target.value })} />
          <input className="editor-id num" value={profile.id} aria-label="标识" placeholder="cs2/iem" spellCheck={false}
            title="小写字母、数字和斜线，发布时作为预设文件名" onChange={(event) => patch({ id: event.target.value })} />
        </div>
        <span className="editor-state" data-state={state}>{STATE_TEXT[state]}</span>
        {validationOpen && <span className="editor-validation-mode">验收模式 / 样式只读</span>}
        <span className="editor-spacer" />
        <LibraryMenu presets={presets} drafts={drafts} onLoadPreset={loadPreset} onLoadDraft={loadDraft}
          onDeleteDraft={async (id) => { await profileStore.remove(id); void refreshLibrary() }} />
        <FileMenu onNew={newProfile} onImport={importFile} onExport={exportFile} />
        <span className="editor-divider" aria-hidden="true" />
        <button type="button" className="btn-quiet" disabled={!video || !duration || countdown.busy || preprocessing.busy || saving !== null}
          onClick={openValidation}>只读批量验收</button>
        <button type="button" className="btn-quiet" disabled={saving !== null} onClick={() => void saveDraft()}>
          {saving === 'draft' ? '正在保存…' : '存为草稿'}
        </button>
        <button type="button" className="btn-quiet" disabled={saving !== null} onClick={() => void publish()}>
          {saving === 'publish' ? '正在发布…' : '发布到本机'}
        </button>
        <button type="button" className="btn-solid" onClick={applyToPlayer}>应用到播放器</button>
      </header>

      {message && (
        <div className={`editor-note is-${message.kind}`} role={message.conflict ? 'alert' : 'status'} aria-label="编辑器提示" inert={validationOpen && !!message.conflict}>
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

      {(project.error || project.needsRelink) && <div className="editor-note is-warn" aria-live="polite" data-testid="project-note" inert={validationOpen}>
        <span>{project.error || '素材文件不可用或大小已改变, 请重新选择原文件并核对 SHA-256.'}</span>
        {project.needsRelink && <button type="button" className="btn-quiet small" onClick={() => void project.choose(true)}>重新选择原素材</button>}
      </div>}

      <main className={`editor-main${validationOpen ? ' is-validating' : ''}`}>
        <section className="editor-stage-col" aria-label="样片">
          {ytSource && !validationOpen && (
            <Segmented label="素材来源" value={footage} onChange={setFootage}
              options={[{ value: 'local', label: '本地文件' }, { value: 'youtube', label: 'YouTube 录像' }]} />
          )}
          {/* Kept mounted while hidden, so the page and a running download survive a switch. */}
          {ytSource && (
            <div className="editor-yt" hidden={footage !== 'youtube'} inert={validationOpen}>
              <YouTubePanel source={ytSource} onStill={openStill} onClipReady={openClip}
                autoStill={autoGrab && !validationOpen} onAutoStillChange={setAutoGrab} active={footage === 'youtube' && !validationOpen} />
            </div>
          )}
          <EditorStage mediaSize={videoSize} roi={profile.roi} enabled={!!sampleUrl} hidden={footage === 'youtube'}
            resetKey={JSON.stringify([sampleUrl, variantId, pack.id])}>
            {picture => <>
            {sampleUrl && sampleKind === 'image' ? (
              <img src={sampleUrl} className="editor-media" alt={sampleName} draggable={false}
                style={{ left: picture.x, top: picture.y, width: picture.width, height: picture.height }} />
            ) : sampleUrl ? (
              <video
                ref={videoRef}
                src={sampleUrl}
                className="editor-media"
                style={{ left: picture.x, top: picture.y, width: picture.width, height: picture.height }}
                controls={false}
                playsInline
                muted
                onLoadedMetadata={(event) => {
                  const node = event.currentTarget
                  stepperRef.current = new FrameStepper(presentAt(node))
                  shownFrame.current = null
                  setVideoSize({ width: node.videoWidth, height: node.videoHeight })
                  setDuration(Number.isFinite(node.duration) ? node.duration : 0)
                }}
                onPlay={() => { setPlaying(true); countdown.onPlay() }}
                onPause={(event) => {
                  setPlaying(false)
                  // A pause that starts a step or a jump is followed by its seek, which grabs.
                  if (autoGrab && !event.currentTarget.seeking && !countdown.isBusy()) grab()
                }}
                onTimeUpdate={(event) => setMediaTime(event.currentTarget.currentTime)}
                onSeeking={(event) => countdown.onSeeking(event.currentTarget)}
                onSeeked={(event) => {
                  setMediaTime(event.currentTarget.currentTime)
                  if (countdown.onSeeked(event.currentTarget)) return
                  // A seek is the usual way to reach the frame you want; grabbing right
                  // after it saves a click and keeps the preview on the picture.
                  if (autoGrab) grab()
                }}
              />
            ) : (
              <div className="editor-empty">
                <p>载入一段比赛录像或一张截图</p>
                <p className="muted">也可以直接按 Ctrl+V 粘贴截图，文件只在本机读取</p>
              </div>
            )}
            {sampleUrl && (
              <>{HUD_FIELD_IDS.filter(id => id === fieldId || variant.fields[id]?.enabled !== false).map(id => (
                <RoiWindow key={id} roi={fieldModel(pack, id, variantId).roi} onChange={setRoi}
                  readOnly={validationOpen || id !== fieldId || !profile.enabled} label={FIELD_LABELS[id]}
                  videoWidth={videoSize.width} videoHeight={videoSize.height} contentBox={picture} />
              ))}{[...HUD_CUE_IDS, 'organizer' as const].filter(id => id === fieldId || (id === 'organizer' ? variant.organizer?.enabled : variant.cues[id]?.enabled)).map(id => (
                <RoiWindow key={id} roi={cueModel(pack, id, variantId).roi} onChange={setRoi} readOnly={validationOpen || id !== fieldId || !profile.enabled} label={CUE_LABELS[id]}
                  videoWidth={videoSize.width} videoHeight={videoSize.height} contentBox={picture} />
              ))}</>
            )}
            </>}
          </EditorStage>

          <div className="editor-transport" hidden={footage === 'youtube'} inert={validationOpen}>
            <button type="button" className="btn-quiet small" onClick={() => void project.choose()}>选择录像</button>
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
                  <button type="button" className="btn-quiet small editor-jump num" disabled={countdown.busy} onClick={() => jump(-10)} title="后退 10 秒（Ctrl+←）">-10s</button>
                  <button type="button" className="btn-quiet small editor-jump num" disabled={countdown.busy} onClick={() => jump(-1)} title="后退 1 秒（Shift+←）">-1s</button>
                  <button type="button" className="icon-btn" disabled={countdown.busy} onClick={() => step(-1)} aria-label="上一帧" title="上一帧（←）"><Icon name="back" /></button>
                  <button type="button" className="icon-btn" disabled={countdown.busy} onClick={togglePlay} aria-label={playing ? '暂停' : '播放'} title="播放 / 暂停（空格）">
                    <Icon name={playing ? 'pause' : 'play'} />
                  </button>
                  <button type="button" className="icon-btn" disabled={countdown.busy} onClick={() => step(1)} aria-label="下一帧" title="下一帧（→）"><Icon name="forward" /></button>
                  <button type="button" className="btn-quiet small editor-jump num" disabled={countdown.busy} onClick={() => jump(1)} title="前进 1 秒（Shift+→）">+1s</button>
                  <button type="button" className="btn-quiet small editor-jump num" disabled={countdown.busy} onClick={() => jump(10)} title="前进 10 秒（Ctrl+→）">+10s</button>
                </span>
                {fieldId === 'clock' && <AutoStepControl running={countdown.autoRunning} canStart={countdown.canAutoStart && !stepping.current}
                  steps={countdown.autoSteps} onStart={countdown.startAuto} onStop={countdown.stopAuto} />}
                <input type="range" className="editor-scrub" disabled={countdown.busy} min={0} max={Math.max(0.1, duration)} step={0.02}
                  value={Math.min(mediaTime, duration || mediaTime)} aria-label="样片进度"
                  style={{ '--fill': `${duration ? (mediaTime / duration) * 100 : 0}%` } as React.CSSProperties}
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    setMediaTime(value)
                    const node = videoRef.current
                    if (node) node.currentTime = value
                  }} />
                <span className="editor-time num"><span>{mediaTime.toFixed(2)}s</span> / {duration ? `${duration.toFixed(2)}s` : '—'}</span>
                <button type="button" className="btn-solid small" disabled={countdown.busy} onClick={grab}>取当前帧</button>
                <Switch label="自动取帧" checked={autoGrab} onChange={setAutoGrab} />
              </>
            ) : (
              <span className="editor-transport-meta muted">
                {sampleUrl ? `${sampleName} · ${videoSize.width}×${videoSize.height}` : ''}
              </span>
            )}
          </div>
          {project.current && <div className="editor-media-info" inert={validationOpen}>
            <span className="muted">{project.current.name}</span>
            <label className="field-stack"><span className="field-label">比赛</span>
              <input className="text-input" aria-label="素材比赛" value={project.current.match}
                onChange={event => project.annotate({ match: event.target.value })} />
            </label>
            <label className="field-stack"><span className="field-label">用途</span>
              <select className="text-input" aria-label="素材用途" value={project.current.purpose}
                onChange={event => project.annotate({ purpose: event.target.value as 'making' | 'validation' })}>
                <option value="making">制作</option><option value="validation">验收</option>
              </select>
            </label>
          </div>}
          {validationOpen && <BatchValidationPanel duration={duration} mediaTime={mediaTime} sourceName={sampleName}
            state={validation.state} onStart={validation.start} onStop={validation.stop} onInspect={validation.inspect}
            onJump={jumpToValidationFrame} onClose={() => {
              if (validation.state.phase === 'running') return
              reviewSeek.current?.abort()
              validation.cancelPreview()
              setValidationOpen(false)
            }} />}
        </section>

        <aside className="editor-rail" aria-label="识别设置" inert={validationOpen} hidden={validationOpen}>
          <LayoutSection key={variantId} pack={pack} variant={variant} canCreate={!!frame}
            onSelect={changeLayout} onCreate={createLayout} onGenerate={generateLayout} onRename={editLayoutId} onDelete={deleteLayout} />
          <section className="rail-group">
            <label className="field-stack">
              <span className="field-label">当前字段</span>
              <select className="text-input" aria-label="当前字段" value={fieldId}
                onChange={event => changeField(event.target.value as EditorTarget)}>
                {HUD_FIELD_IDS.map(id => <option key={id} value={id}>{FIELD_LABELS[id]}{variant.fields[id]?.enabled === false ? ' (已关闭)' : ''}</option>)}
                {[...HUD_CUE_IDS, 'organizer' as const].map(id => <option key={id} value={id}>{CUE_LABELS[id]}{(id === 'organizer' ? variant.organizer : variant.cues[id])?.enabled === false ? ' (已关闭)' : ''}</option>)}
              </select>
            </label>
            <Switch label="启用当前字段" checked={profile.enabled} onChange={toggleField}
              detail="关闭后保留区域, 参数和样本, 不参与识别" />
            {!profile.enabled && <p className="muted" role="note">该字段已关闭. 下方配置仅供查看, 重新启用后可继续制作.</p>}
          </section>
          <fieldset className="editor-field-controls" disabled={!profile.enabled} aria-label="当前字段设置">
          <RegionSection fieldId={numericId} label={cueId ? CUE_LABELS[cueId] : undefined} roi={profile.roi} onRoi={setRoi} videoSize={videoSize} analysis={analysis}
            boxes={boxes} selected={selected} onSelect={setSelected}
            grayRef={grayCanvasRef} binaryRef={binaryCanvasRef} />
          <BinarizeSection profile={profile} onPatch={patchPreprocess} frame={frame}
            busy={!profile.enabled || countdown.busy || preprocessing.busy} onRecommend={(kind, point) => { void preprocessing.recommend(kind, point) }} />
          {cueId ? <CueSection id={cueId} pack={activePack} variantId={variantId} result={cueId === 'organizer' ? frameResult?.organizer : frameResult?.cues[cueId]}
            onSave={frame && profile.enabled ? () => void saveCue() : null} onThreshold={matchThreshold => patch({ matchThreshold })}
            onRemove={bitmapId => {
              ++editRevision.current
              setPack(current => {
                const selectedVariant = editorVariant(current, variantId)
                const cue = { ...editorCue(current, cueId, variantId), templates: editorCue(current, cueId, variantId).templates.filter(id => id !== bitmapId) }
                return { ...current, revision: current.revision + 1, variants: current.variants.map(item => item.id !== variantId ? item : { ...selectedVariant,
                  ...(cueId === 'organizer' ? { organizer: cue } : { cues: { ...selectedVariant.cues, [cueId]: cue } }) }) }
              })
              setDirty(true)
            }} /> : <>
          <GlyphSection key={`glyph-${variantId}-${fieldId}`} fieldId={numericId} profile={profile} readiness={readiness} boxes={boxes} selected={selected}
            reading={countdown.reading} onUndo={countdown.undo} busy={countdown.busy || !profile.enabled}
            bounds={analysis ? { width: analysis.binary.width, height: analysis.binary.height } : null}
            onBoxes={setBoxes} onAssign={assign} onVerify={frame && profile.enabled ? verifyFrame : null}
            recognized={profile.enabled ? recognized : { status: 'disabled', debug: null }} />
          {!validationOpen && <StretchSection key={`stretch-${variantId}-${fieldId}-${profile.enabled}`} fieldId={numericId} variantId={variantId} video={video && profile.enabled ? videoRef.current : null} pack={activePack} onSave={saveStretch} />}
          <SampleSection fieldId={numericId} profile={profile} onRemove={removeSample} />
          <ParamsSection fieldId={numericId} profile={profile} onPatch={patch} />
          </>}
          </fieldset>
          <FrameStatePreview result={frameResult} playerResult={playerFrameResult} />
          <StateRules pack={pack} variantId={variantId} onChange={states => {
            ++editRevision.current
            setPack(current => ({ ...current, revision: current.revision + 1,
              variants: current.variants.map(item => item.id !== variantId ? item : { ...item, states }) }))
            setDirty(true)
          }} />
        </aside>
      </main>
    </div>
  )
}

const STATE_TEXT = { dirty: '未保存', published: '已发布', unpublished: '未发布' } as const
