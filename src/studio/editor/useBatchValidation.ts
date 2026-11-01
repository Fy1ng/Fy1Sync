import { useCallback, useEffect, useRef, useState } from 'react'
import type { HudStylePack } from '../../core/hudStylePack'
import { BatchValidationSession } from './batchValidationRunner'
import { EMPTY_VALIDATION_STATE, type ValidationRange, type ValidationState } from './batchValidationTypes'

export function useBatchValidation(options: { source: string; sourceName: string; pack: HudStylePack; duration: number }) {
  const latest = useRef(options)
  latest.current = options
  const [state, setState] = useState<ValidationState>(EMPTY_VALIDATION_STATE)
  const session = useRef<BatchValidationSession | null>(null)
  const scan = useRef<AbortController | null>(null)
  const preview = useRef<AbortController | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    scan.current?.abort()
    preview.current?.abort()
    scan.current = null
    preview.current = null
    session.current = null
    setState(EMPTY_VALIDATION_STATE)
    return () => {
      mounted.current = false
      scan.current?.abort()
      preview.current?.abort()
      scan.current = null
      preview.current = null
    }
  }, [options.source])

  const stop = useCallback(() => { scan.current?.abort() }, [])
  const cancelPreview = useCallback(() => {
    preview.current?.abort()
    preview.current = null
    setState(current => ({ ...current, previewBusy: false }))
  }, [])
  const start = useCallback((range: ValidationRange): void => {
    if (scan.current || !latest.current.source) return
    preview.current?.abort()
    preview.current = null
    let next: BatchValidationSession
    try { next = new BatchValidationSession({ ...latest.current, range }) } catch (error) {
      setState(current => ({ ...current, error: error instanceof Error ? error.message : String(error) }))
      return
    }
    session.current = next
    const controller = new AbortController()
    scan.current = controller
    setState({ ...EMPTY_VALIDATION_STATE, phase: 'running', run: next.run })
    let lastPaint = 0
    const current = (): boolean => mounted.current && session.current === next && scan.current === controller
    void next.scan(controller.signal, () => {
      if (current() && Date.now() - lastPaint >= 100) {
        lastPaint = Date.now()
        setState(value => ({ ...value, rows: [...next.rows] }))
      }
    }).then(() => {
      if (current()) setState(value => ({ ...value, phase: controller.signal.aborted ? 'stopped' : 'complete', rows: [...next.rows] }))
    }, error => {
      if (current()) setState(value => ({ ...value, phase: controller.signal.aborted ? 'stopped' : 'error', rows: [...next.rows],
        error: controller.signal.aborted ? null : error instanceof Error ? error.message : String(error) }))
    }).finally(() => { if (scan.current === controller) scan.current = null })
  }, [])

  const inspect = useCallback((index: number): void => {
    const snapshot = session.current
    if (!snapshot || scan.current || !snapshot.rows[index]) return
    preview.current?.abort()
    const controller = new AbortController()
    preview.current = controller
    setState(value => ({ ...value, previewBusy: true, preview: null, selectedIndex: index, error: null }))
    const current = (): boolean => mounted.current && session.current === snapshot && preview.current === controller
    void snapshot.inspect(index, controller.signal).then(result => {
      if (current()) setState(value => ({ ...value, preview: result }))
    }, error => {
      if (current() && !controller.signal.aborted) setState(value => ({ ...value, error: `预览失败: ${error instanceof Error ? error.message : String(error)}` }))
    }).finally(() => {
      if (current()) { preview.current = null; setState(value => ({ ...value, previewBusy: false })) }
    })
  }, [])

  return { state, start, stop, inspect, cancelPreview }
}
