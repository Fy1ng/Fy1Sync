/** Whole-second teaching is a transaction: seek, capture, label, then append samples. */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { parseCountdown } from '../../core/clockJump'
import { prepareHudGlyphs } from '../../core/hudWasm'
import type { HudStylePack } from '../../core/hudStylePack'
import { CLOCK_CHARS, type ClockChar } from '../../core/profileSchema'
import type { GlyphBox } from '../../core/segmentation'
import { FULL_FRAME_ROI, type FrameGrabber, type GrabbedFrame } from '../../recognition/frameGrabber'
import type { EditorTarget } from './cueModel'
import { fieldModel, patchField } from './editorModel'
import { sampleFromPrepared } from './framePipeline'
import { clockText, pairReading } from './reading'

interface Options {
  pack: HudStylePack
  fieldId: EditorTarget
  variantId: string
  source: string
  sampleName: string
  video: RefObject<HTMLVideoElement | null>
  grabber: RefObject<FrameGrabber>
  revision: RefObject<number>
  documentRevision: number
  onFrame: (frame: GrabbedFrame) => void
  onPack: (pack: HudStylePack) => void
  onMessage: (message: { kind: 'info' | 'warn' | 'error'; text: string }) => void
}

interface UndoStep {
  from: number
  reading: string
  added: string[]
}

interface Pending {
  video: HTMLVideoElement
  context: string
  revision: number
  from: number
  to: number
  before: string
  next: string | null
  problem: string | null
  undo?: UndoStep
  capturing: boolean
  timer: ReturnType<typeof setTimeout>
}

export function useCountdownTeaching(options: Options) {
  const latest = useRef(options)
  latest.current = options
  const context = JSON.stringify([options.pack.id, options.variantId, options.fieldId, options.source, options.documentRevision])
  const contextRef = useRef(context)
  contextRef.current = context
  const [reading, setReading] = useState('')
  const readingRef = useRef('')
  const anchor = useRef<{ video: HTMLVideoElement; time: number } | null>(null)
  const glyphReading = useRef<{ frame: GrabbedFrame; boxes: GlyphBox[]; chars: Array<ClockChar | null> } | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef<Pending | null>(null)
  const [undoSteps, setUndoSteps] = useState<UndoStep[]>([])
  const history = useRef<UndoStep[]>([])
  const mounted = useRef(true)

  const finish = useCallback(() => {
    if (pending.current) clearTimeout(pending.current.timer)
    pending.current = null
    if (mounted.current) setBusy(false)
  }, [])
  const updateReading = useCallback((text: string) => {
    readingRef.current = text
    const video = latest.current.video.current
    anchor.current = video && text.trim() ? { video, time: video.currentTime } : null
    setReading(text)
  }, [])
  const changeReading = useCallback((text: string) => {
    glyphReading.current = null
    updateReading(text)
  }, [updateReading])
  /** Per-box teaching establishes the same baseline once every visible glyph is labelled. */
  const recordGlyph = (char: ClockChar, index: number, boxes: GlyphBox[], frame: GrabbedFrame): void => {
    const current = latest.current
    if (current.fieldId !== 'clock' || pending.current || !boxes[index]) return
    const video = current.video.current
    if (video && (!video.paused || video.seeking || Math.abs(video.currentTime - frame.mediaTime) > 1e-6)) {
      changeReading('')
      return
    }
    let labelled = glyphReading.current
    if (!labelled || labelled.frame !== frame || labelled.boxes !== boxes) {
      labelled = { frame, boxes, chars: Array<ClockChar | null>(boxes.length).fill(null) }
      glyphReading.current = labelled
    }
    labelled.chars[index] = char
    const text = labelled.chars.every(value => value !== null) ? labelled.chars.join('') : ''
    const format = fieldModel(current.pack, 'clock', current.variantId).clockFormat
    updateReading(parseCountdown(text, format) === null ? '' : text)
  }
  const reset = useCallback(() => {
    finish()
    changeReading('')
    history.current = []
    setUndoSteps([])
  }, [changeReading, finish])
  useEffect(() => { reset() }, [context, reset])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (pending.current) clearTimeout(pending.current.timer)
      pending.current = null
    }
  }, [])

  const isCurrent = (job: Pending): boolean => pending.current === job && mounted.current
    && contextRef.current === job.context && latest.current.revision.current === job.revision
    && latest.current.video.current === job.video && job.video.paused
    && Math.abs(job.video.currentTime - job.to) < 1e-6

  const complete = async (job: Pending): Promise<void> => {
    if (job.capturing) return
    job.capturing = true
    try {
      if (!isCurrent(job)) throw new Error('当前素材或设置已改变, 本次未自动写入')
      const current = latest.current
      const captured = current.grabber.current.grab(job.video, FULL_FRAME_ROI, job.video.currentTime)
      if (!captured.ok) throw new Error(`取帧失败 (${captured.reason}), 本次未自动写入`)
      current.onFrame(captured.frame)
      changeReading(job.next ?? '')
      if (job.problem) {
        current.onMessage({ kind: 'warn', text: job.problem })
        return
      }
      if (job.undo) {
        current.onPack(removeSamples(current.pack, current.variantId, new Set(job.undo.added)))
        history.current = history.current.slice(0, -1)
        setUndoSteps(history.current)
        current.onMessage({ kind: 'info', text: '已撤回上次自动写入, 并恢复跳转前的画面和读数' })
        return
      }
      const prepared = await prepareHudGlyphs(captured.frame, current.pack, current.variantId, undefined, 'clock')
      if (!isCurrent(job) || readingRef.current !== job.next) throw new Error('当前素材或设置已改变, 本次未自动写入')
      const paired = pairReading(job.next!, prepared.boxes.length)
      if (!paired.ok) throw new Error(`${paired.reason}; 本次未自动写入`)
      const model = fieldModel(current.pack, 'clock', current.variantId)
      const templates = { ...model.templates }
      for (const [index, char] of paired.chars.entries()) {
        const sample = sampleFromPrepared(prepared.bitmaps[index]!, char, `${current.sampleName || '样片'} @ ${job.to.toFixed(2)}s`)
        templates[char] = [...(templates[char] ?? []), sample]
      }
      const updated = patchField(current.pack, 'clock', { templates }, current.variantId)
      const previousIds = new Set(Object.values(model.templates).flatMap(samples => samples.map(sample => sample.id)))
      const added = Object.values(fieldModel(updated, 'clock', current.variantId).templates)
        .flatMap(samples => samples.map(sample => sample.id)).filter(id => !previousIds.has(id))
      current.onPack(updated)
      history.current = [...history.current, { from: job.from, reading: job.before, added }]
      setUndoSteps(history.current)
      current.onMessage({ kind: 'info', text: `倒计时已同步为 ${job.next}, 自动写入 ${paired.chars.length} 个字符样本, 可撤回` })
    } catch (error) {
      if (pending.current === job && mounted.current && contextRef.current === job.context) {
        if (anchor.current && Math.abs(anchor.current.time - job.video.currentTime) > 1e-6) changeReading('')
        latest.current.onMessage({ kind: 'warn', text: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      if (pending.current === job) finish()
    }
  }

  const begin = (video: HTMLVideoElement, to: number, next: string | null, problem: string | null, undo?: UndoStep): void => {
    const job: Pending = { video, to, next, problem, undo, from: video.currentTime, before: readingRef.current,
      context: contextRef.current, revision: latest.current.revision.current, capturing: false,
      timer: setTimeout(() => {
        if (pending.current !== job) return
        finish()
        changeReading('')
        latest.current.onMessage({ kind: 'warn', text: '等待目标画面超时, 未改动模板, 请重新取帧并填写读数' })
      }, 10_000) }
    pending.current = job
    setBusy(true)
    video.pause()
    try {
      if (Math.abs(video.currentTime - to) < 1e-6 && !video.seeking) void complete(job)
      else video.currentTime = to
    } catch (error) {
      finish()
      latest.current.onMessage({ kind: 'error', text: `跳转失败, 未改动模板: ${String(error)}` })
    }
  }

  /** Empty readings and non-clock fields retain ordinary transport behavior. */
  const jump = (seconds: number): boolean => {
    const current = latest.current
    const video = current.video.current
    if (pending.current) return true
    if (!video || current.fieldId !== 'clock' || !readingRef.current.trim()) return false
    const end = Number.isFinite(video.duration) ? video.duration : video.currentTime
    const to = Math.max(0, Math.min(end, video.currentTime + seconds))
    if (Math.abs(to - video.currentTime) < 1e-6) return true
    const format = fieldModel(current.pack, 'clock', current.variantId).clockFormat
    const parsed = parseCountdown(readingRef.current.replace(/\s+/g, ''), format)
    const elapsed = to - video.currentTime
    const nextSeconds = parsed === null ? -1 : parsed - Math.round(elapsed)
    const next = clockText(nextSeconds, format)
    const validAnchor = anchor.current?.video === video && Math.abs(anchor.current.time - video.currentTime) < 1e-6
    const problem = !validAnchor ? '当前读数不属于这一帧, 本次未自动写入, 请重新填写倒计时'
      : parsed === null ? '当前倒计时格式无效, 本次未自动写入, 请重新填写读数'
        : Math.abs(elapsed - Math.round(elapsed)) > 1e-6 ? '素材边界不足整秒, 本次未自动写入, 请确认目标帧读数'
          : nextSeconds < 0 || parseCountdown(next, format) !== nextSeconds ? '跳转后的倒计时超出格式范围, 本次未自动写入, 请确认新回合或暂停状态'
            : null
    begin(video, to, problem ? null : next, problem)
    return true
  }

  const undo = (): void => {
    const step = history.current.at(-1)
    const video = latest.current.video.current
    if (!step || !video || pending.current) return
    begin(video, step.from, step.reading, null, step)
  }
  const onSeeking = (video: HTMLVideoElement): void => {
    if (pending.current?.video === video && Math.abs(pending.current.to - video.currentTime) < 1e-6) return
    if (latest.current.fieldId === 'clock') {
      finish()
      changeReading('')
    }
  }
  const onSeeked = (video: HTMLVideoElement): boolean => {
    const job = pending.current
    if (!job || job.video !== video) return false
    void complete(job)
    return true
  }
  const onPlay = (): void => {
    if (latest.current.fieldId === 'clock') {
      finish()
      changeReading('')
    }
  }

  return { reading, changeReading, recordGlyph, busy, jump, undo: undoSteps.length ? undo : null, reset,
    onSeeking, onSeeked, onPlay, isBusy: () => pending.current !== null }
}

/** Remove only this transaction's glyphs, preserving later edits and shared bitmaps. */
function removeSamples(pack: HudStylePack, variantId: string, added: Set<string>): HudStylePack {
  const model = fieldModel(pack, 'clock', variantId)
  const templates = Object.fromEntries(CLOCK_CHARS.flatMap(char => {
    const kept = model.templates[char]?.filter(sample => !added.has(sample.id)) ?? []
    return kept.length ? [[char, kept]] : []
  }))
  const updated = patchField(pack, 'clock', { templates }, variantId)
  const referenced = new Set(updated.variants.flatMap(variant => [
    ...Object.values(variant.fields).flatMap(field => Object.values(field?.glyphs ?? {}).flat()),
    ...Object.values(variant.cues).flatMap(cue => cue?.templates ?? []), ...(variant.organizer?.templates ?? []),
  ]))
  for (const id of added) if (!referenced.has(id)) delete updated.bitmaps[id]
  return updated
}
