/** Explicit character labels share one reversible sample transaction history. */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { prepareHudGlyphs } from '../../core/hudWasm'
import type { HudFieldId, HudStylePack } from '../../core/hudStylePack'
import type { ClockChar } from '../../core/profileSchema'
import type { GlyphBox } from '../../core/segmentation'
import { FULL_FRAME_ROI, type FrameGrabber, type GrabbedFrame } from '../../recognition/frameGrabber'
import { isCueTarget, type EditorTarget } from './cueModel'
import { applyGlyphChange, glyphFrameKey, labelledReading, teachGlyphs, type GlyphChange } from './glyphTeaching'

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
  at: number
  frame: GrabbedFrame | null
  fieldId: HudFieldId
  variantId: string
  selected: number
  change: GlyphChange
}

interface Pending {
  kind: 'glyph' | 'undo'
  video: HTMLVideoElement | null
  context: string
  revision: number
  from: number
  to: number
  beforeFrame: GrabbedFrame | null
  undo?: UndoStep
  capturing: boolean
  timer: ReturnType<typeof setTimeout>
}

export function useCountdownTeaching(options: Options) {
  const latest = useRef(options)
  latest.current = options
  const targetVariant = options.pack.variants.find(variant => variant.id === options.variantId)
  const target = isCueTarget(options.fieldId) ? options.fieldId === 'organizer' ? targetVariant?.organizer : targetVariant?.cues[options.fieldId]
    : targetVariant?.fields[options.fieldId]
  const context = JSON.stringify([options.pack.id, options.variantId, options.fieldId, target?.enabled, options.source, options.documentRevision])
  const contextRef = useRef(context)
  contextRef.current = context
  const [reading, setReading] = useState('')
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
  const reset = useCallback(() => {
    finish()
    setReading('')
    history.current = []
    selectionAfterAnalysis.current = null
    setUndoCount(0)
  }, [finish])
  useEffect(() => { reset() }, [context, reset])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (pending.current) clearTimeout(pending.current.timer)
      pending.current = null
    }
  }, [])

  // Recover only labels explicitly stored for this frame and its character slots.
  useEffect(() => {
    const { frame, boxes, pack, fieldId, variantId } = options
    if (busy) return
    if (!frame || !boxes.length || isCueTarget(fieldId) || !pack.variants.find(variant => variant.id === variantId)?.fields[fieldId]?.enabled) { setReading(''); return }
    let active = true
    void glyphFrameKey(frame, pack, fieldId, variantId, boxes).then(key => {
      if (!active || pending.current) return
      setReading(labelledReading(pack, fieldId, variantId, key, boxes.length))
      const selection = selectionAfterAnalysis.current
      if (selection?.frame === frame) {
        latest.current.onSelect(Math.min(selection.selected, boxes.length - 1))
        selectionAfterAnalysis.current = null
      }
    }).catch(() => { if (active) setReading('') })
    return () => { active = false }
  }, [options.frame, options.boxes, options.pack, options.fieldId, options.variantId, busy, context])

  const isCurrent = (job: Pending): boolean => pending.current === job && mounted.current
    && contextRef.current === job.context && latest.current.revision.current === job.revision
    && latest.current.video.current === job.video && (!job.video || (job.video.paused
      && Math.abs(job.video.currentTime - job.to) < 1e-6))

  const begin = (kind: Pending['kind'], to: number, undo?: UndoStep): Pending => {
    const current = latest.current
    const video = current.video.current
    const job: Pending = { kind, video, to, undo, beforeFrame: video ? null : current.frame,
      from: video?.currentTime ?? current.frame?.mediaTime ?? 0,
      context: contextRef.current, revision: current.revision.current, capturing: false,
      timer: setTimeout(() => {
        if (pending.current !== job) return
        finish()
        setReading('')
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
      setReading('')
      latest.current.onMessage({ kind: 'warn', text: error instanceof Error ? error.message : String(error) })
    }
  }

  const assign = async (char: ClockChar, index: number): Promise<void> => {
    const current = latest.current
    const { frame, boxes, fieldId, variantId } = current
    if (pending.current || !frame || !boxes[index] || isCueTarget(fieldId) || (fieldId !== 'clock' && char === ':')) return
    if (!current.pack.variants.find(variant => variant.id === variantId)?.fields[fieldId]?.enabled) return
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
        push({ at: job.from, frame: job.beforeFrame, fieldId, variantId, selected: index, change: result.change })
      }
      setReading(labelledReading(result.pack, fieldId, variantId, key, boxes.length))
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
      if (!isCurrent(job)) throw new Error('当前素材或设置已改变, 本次未撤回')
      const current = latest.current
      const sameFrame = current.frame
        && Math.abs(current.frame.mediaTime - job.to) < 1e-6 ? current.frame : null
      const captured = sameFrame ? { ok: true as const, frame: sameFrame }
        : job.video ? current.grabber.current.grab(job.video, FULL_FRAME_ROI, job.video.currentTime)
        : job.undo?.frame ? { ok: true as const, frame: job.undo.frame } : null
      if (!captured?.ok) throw new Error('取帧失败, 本次未改动模板')
      if (!sameFrame) current.onFrame(captured.frame)
      if (job.undo) {
        const { change, fieldId, variantId, selected } = job.undo
        const restored = applyGlyphChange(current.pack, fieldId, variantId, { removed: change.added, added: change.removed })
        if (restored !== current.pack) current.onPack(restored)
        history.current = history.current.slice(0, -1)
        setUndoCount(history.current.length)
        selectionAfterAnalysis.current = { frame: captured.frame, selected }
        current.onSelect(selected)
        setReading('')
        current.onMessage({ kind: 'info', text: '已撤回上次字符标注' })
        return
      }
    } catch (error) { fail(job, error) }
    finally {
      if (pending.current === job) finish()
    }
  }

  const seek = (job: Pending): void => {
    job.video?.pause()
    try {
      if (!job.video || (Math.abs(job.video.currentTime - job.to) < 1e-6 && !job.video.seeking)) void complete(job)
      else job.video.currentTime = job.to
    } catch (error) { fail(job, error); finish() }
  }
  const undo = (): void => {
    const step = history.current.at(-1)
    if (!step || pending.current) return
    seek(begin('undo', step.at, step))
  }
  const onSeeking = (video: HTMLVideoElement): void => {
    if (pending.current?.video === video && Math.abs(pending.current.to - video.currentTime) < 1e-6) return
    finish()
    setReading('')
  }
  const onSeeked = (video: HTMLVideoElement): boolean => {
    const job = pending.current
    if (!job || job.video !== video || job.kind === 'glyph') return false
    void complete(job)
    return true
  }
  const onPlay = (): void => {
    finish(); setReading('')
  }

  return { reading, assign, busy, undo: undoCount ? undo : null, reset,
    onSeeking, onSeeked, onPlay, isBusy: () => pending.current !== null }
}
