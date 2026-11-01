/** Character buttons and timed jumps share one reversible sample transaction history. */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { parseCountdown } from '../../core/clockJump'
import { prepareHudGlyphs } from '../../core/hudWasm'
import type { HudFieldId, HudStylePack } from '../../core/hudStylePack'
import type { ClockChar } from '../../core/profileSchema'
import type { GlyphBox } from '../../core/segmentation'
import { FULL_FRAME_ROI, type FrameGrabber, type GrabbedFrame } from '../../recognition/frameGrabber'
import { isCueTarget, type EditorTarget } from './cueModel'
import { fieldModel } from './editorModel'
import { applyGlyphChange, glyphFrameKey, labelledReading, teachGlyphs, type GlyphChange } from './glyphTeaching'
import { clockText, pairReading } from './reading'

interface Options {
  pack: HudStylePack
  fieldId: EditorTarget
  variantId: string
  source: string
  video: RefObject<HTMLVideoElement | null>
  grabber: RefObject<FrameGrabber>
  revision: RefObject<number>
  documentRevision: number
  frame: GrabbedFrame | null
  boxes: GlyphBox[]
  onFrame: (frame: GrabbedFrame) => void
  onPack: (pack: HudStylePack) => void
  onSelect: (index: number) => void
  onMessage: (message: { kind: 'info' | 'warn' | 'error'; text: string }) => void
}

interface UndoStep {
  kind: 'glyph' | 'jump'
  at: number
  frame: GrabbedFrame | null
  fieldId: HudFieldId
  variantId: string
  selected: number
  change: GlyphChange
}

interface Pending {
  kind: 'glyph' | 'jump' | 'undo'
  video: HTMLVideoElement | null
  context: string
  revision: number
  from: number
  to: number
  beforeFrame: GrabbedFrame | null
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
  const [busy, setBusy] = useState(false)
  const pending = useRef<Pending | null>(null)
  const [undoCount, setUndoCount] = useState(0)
  const history = useRef<UndoStep[]>([])
  const mounted = useRef(true)
  const selectionAfterAnalysis = useRef<{ frame: GrabbedFrame; selected: number } | null>(null)

  const finish = useCallback(() => {
    if (pending.current) clearTimeout(pending.current.timer)
    pending.current = null
    if (mounted.current) setBusy(false)
  }, [])
  const updateReading = useCallback((text: string, frame?: GrabbedFrame | null) => {
    readingRef.current = text
    const video = latest.current.video.current
    anchor.current = video && text && (!frame || Math.abs(frame.mediaTime - video.currentTime) < 1e-6)
      ? { video, time: video.currentTime } : null
    setReading(text)
  }, [])
  const reset = useCallback(() => {
    finish()
    updateReading('')
    history.current = []
    selectionAfterAnalysis.current = null
    setUndoCount(0)
  }, [updateReading, finish])
  useEffect(() => { reset() }, [context, reset])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (pending.current) clearTimeout(pending.current.timer)
      pending.current = null
    }
  }, [])

  // Recover labels from stored IDs, including a re-capture, a revisit and a saved project.
  useEffect(() => {
    const { frame, boxes, pack, fieldId, variantId } = options
    if (busy) return
    if (!frame || !boxes.length || isCueTarget(fieldId)) { updateReading(''); return }
    let active = true
    void glyphFrameKey(frame, pack, fieldId, variantId, boxes).then(key => {
      if (!active || pending.current) return
      updateReading(labelledReading(pack, fieldId, variantId, key, boxes.length), frame)
      const selection = selectionAfterAnalysis.current
      if (selection?.frame === frame) {
        latest.current.onSelect(Math.min(selection.selected, boxes.length - 1))
        selectionAfterAnalysis.current = null
      }
    }).catch(() => { if (active) updateReading('') })
    return () => { active = false }
  }, [options.frame, options.boxes, options.pack, options.fieldId, options.variantId, busy, context, updateReading])

  const isCurrent = (job: Pending): boolean => pending.current === job && mounted.current
    && contextRef.current === job.context && latest.current.revision.current === job.revision
    && latest.current.video.current === job.video && (!job.video || (job.video.paused
      && Math.abs(job.video.currentTime - job.to) < 1e-6))

  const begin = (kind: Pending['kind'], to: number, next: string | null = null, problem: string | null = null,
    undo?: UndoStep): Pending => {
    const current = latest.current
    const video = current.video.current
    const job: Pending = { kind, video, to, next, problem, undo, beforeFrame: video ? null : current.frame,
      from: video?.currentTime ?? current.frame?.mediaTime ?? 0,
      context: contextRef.current, revision: current.revision.current, capturing: false,
      timer: setTimeout(() => {
        if (pending.current !== job) return
        finish()
        updateReading('')
        latest.current.onMessage({ kind: 'warn', text: '等待画面或制字超时, 本次未改动模板, 请重新取帧' })
      }, 10_000) }
    pending.current = job
    setBusy(true)
    return job
  }
  const push = (step: UndoStep): void => {
    history.current = [...history.current, step]
    setUndoCount(history.current.length)
  }
  const fail = (job: Pending, error: unknown): void => {
    if (pending.current === job && mounted.current && contextRef.current === job.context) {
      updateReading('')
      latest.current.onMessage({ kind: 'warn', text: error instanceof Error ? error.message : String(error) })
    }
  }

  const assign = async (char: ClockChar, index: number): Promise<void> => {
    const current = latest.current
    const { frame, boxes, fieldId, variantId } = current
    if (pending.current || !frame || !boxes[index] || isCueTarget(fieldId) || (fieldId !== 'clock' && char === ':')) return
    const video = current.video.current
    if (video && (!video.paused || video.seeking || Math.abs(frame.mediaTime - video.currentTime) > 1e-6)) {
      current.onMessage({ kind: 'warn', text: '请先暂停并取当前帧, 再点击字符按钮' })
      return
    }
    const job = begin('glyph', video?.currentTime ?? frame.mediaTime)
    try {
      const [prepared, key] = await Promise.all([
        prepareHudGlyphs(frame, current.pack, variantId, boxes, fieldId), glyphFrameKey(frame, current.pack, fieldId, variantId, boxes),
      ])
      const result = await teachGlyphs(current.pack, fieldId, variantId, key, boxes.length,
        [{ char, index, data: prepared.bitmaps[index]! }])
      if (!isCurrent(job) || latest.current.frame !== frame || latest.current.boxes !== boxes) throw new Error('画面或设置已改变, 本次未写入样本')
      if (result.pack !== current.pack) {
        current.onPack(result.pack)
        push({ kind: 'glyph', at: job.from, frame: job.beforeFrame, fieldId, variantId, selected: index, change: result.change })
      }
      updateReading(labelledReading(result.pack, fieldId, variantId, key, boxes.length), frame)
      current.onSelect(index + 1 < boxes.length ? index + 1 : -1)
      current.onMessage({ kind: 'info', text: result.pack === current.pack ? '这一帧的该字符已保存, 未重复添加'
        : `已标注字符 ${char}, 可撤回` })
    } catch (error) { fail(job, error) }
    finally { if (pending.current === job) finish() }
  }

  const complete = async (job: Pending): Promise<void> => {
    if (job.capturing) return
    job.capturing = true
    try {
      if (!isCurrent(job)) throw new Error('当前素材或设置已改变, 本次未自动写入')
      const current = latest.current
      const sameFrame = job.undo?.kind === 'glyph' && current.frame
        && Math.abs(current.frame.mediaTime - job.to) < 1e-6 ? current.frame : null
      const captured = sameFrame ? { ok: true as const, frame: sameFrame }
        : job.video ? current.grabber.current.grab(job.video, FULL_FRAME_ROI, job.video.currentTime)
        : job.undo?.frame ? { ok: true as const, frame: job.undo.frame } : null
      if (!captured?.ok) throw new Error('取帧失败, 本次未改动模板')
      if (!sameFrame) current.onFrame(captured.frame)
      if (job.problem) {
        updateReading('')
        current.onMessage({ kind: 'warn', text: job.problem })
        return
      }
      if (job.undo) {
        const { change, fieldId, variantId, selected } = job.undo
        const restored = applyGlyphChange(current.pack, fieldId, variantId, { removed: change.added, added: change.removed })
        if (restored !== current.pack) current.onPack(restored)
        history.current = history.current.slice(0, -1)
        setUndoCount(history.current.length)
        selectionAfterAnalysis.current = { frame: captured.frame, selected }
        current.onSelect(selected)
        updateReading('')
        current.onMessage({ kind: 'info', text: job.undo.kind === 'glyph' ? '已撤回上次字符标注' : '已撤回上次跳秒自动写入' })
        return
      }
      const prepared = await prepareHudGlyphs(captured.frame, current.pack, current.variantId, undefined, 'clock')
      const paired = pairReading(job.next!, prepared.boxes.length)
      if (!paired.ok) throw new Error(`${paired.reason}; 本次未自动写入`)
      const key = await glyphFrameKey(captured.frame, current.pack, 'clock', current.variantId, prepared.boxes)
      const result = await teachGlyphs(current.pack, 'clock', current.variantId, key, prepared.boxes.length,
        paired.chars.map((char, index) => ({ char, index, data: prepared.bitmaps[index]! })))
      if (!isCurrent(job)) throw new Error('当前素材或设置已改变, 本次未自动写入')
      if (result.pack !== current.pack) current.onPack(result.pack)
      // An idempotent revisit still undoes the seek without deleting its older samples.
      push({ kind: 'jump', at: job.from, frame: job.beforeFrame, fieldId: 'clock', variantId: current.variantId,
        selected: 0, change: result.change })
      updateReading(job.next!, captured.frame)
      current.onMessage({ kind: 'info', text: result.pack === current.pack ? `倒计时已同步为 ${job.next}, 该帧已保存, 未重复添加`
        : `倒计时已同步为 ${job.next}, 已自动写入字符样本, 可撤回` })
    } catch (error) { fail(job, error) }
    finally { if (pending.current === job) finish() }
  }

  const seek = (job: Pending): void => {
    job.video?.pause()
    try {
      if (!job.video || (Math.abs(job.video.currentTime - job.to) < 1e-6 && !job.video.seeking)) void complete(job)
      else job.video.currentTime = job.to
    } catch (error) { fail(job, error); finish() }
  }
  const jump = (seconds: number): boolean => {
    const current = latest.current
    const video = current.video.current
    if (pending.current) return true
    if (!video || current.fieldId !== 'clock' || !readingRef.current || readingRef.current.includes('?')) return false
    const end = Number.isFinite(video.duration) ? video.duration : video.currentTime
    const to = Math.max(0, Math.min(end, video.currentTime + seconds))
    if (Math.abs(to - video.currentTime) < 1e-6) return true
    const format = fieldModel(current.pack, 'clock', current.variantId).clockFormat
    const parsed = parseCountdown(readingRef.current, format)
    const elapsed = to - video.currentTime
    const nextSeconds = parsed === null ? -1 : parsed - Math.round(elapsed)
    const next = clockText(nextSeconds, format)
    const validAnchor = anchor.current?.video === video && Math.abs(anchor.current.time - video.currentTime) < 1e-6
    const problem = !validAnchor ? '当前标注不属于这一帧, 本次未自动写入, 请重新标注'
      : parsed === null ? '倒计时标注格式无效, 本次未自动写入, 请更正字符'
        : Math.abs(elapsed - Math.round(elapsed)) > 1e-6 ? '素材边界不足整秒, 本次未自动写入, 请标注目标帧'
          : nextSeconds < 0 || parseCountdown(next, format) !== nextSeconds ? '跳转后的倒计时超出格式范围, 请确认新回合或暂停状态'
            : null
    seek(begin('jump', to, problem ? null : next, problem))
    return true
  }
  const undo = (): void => {
    const step = history.current.at(-1)
    if (!step || pending.current) return
    seek(begin('undo', step.at, null, null, step))
  }
  const onSeeking = (video: HTMLVideoElement): void => {
    if (pending.current?.video === video && Math.abs(pending.current.to - video.currentTime) < 1e-6) return
    finish()
    updateReading('')
  }
  const onSeeked = (video: HTMLVideoElement): boolean => {
    const job = pending.current
    if (!job || job.video !== video || job.kind === 'glyph') return false
    void complete(job)
    return true
  }
  const onPlay = (): void => { finish(); updateReading('') }

  return { reading, assign, busy, jump, undo: undoCount ? undo : null, reset,
    onSeeking, onSeeked, onPlay, isBusy: () => pending.current !== null }
}
