import { useCallback, useEffect, useRef, useState } from 'react'
import type { HudStylePack } from '../../core/hudStylePack'
import { BatchValidationSession } from './batchValidationRunner'
import { EMPTY_VALIDATION_STATE, type ValidationRange, type ValidationRow, type ValidationState } from './batchValidationTypes'

interface ActiveScan {
  controller: AbortController
  session: BatchValidationSession
  stoppedRows: ValidationRow[] | null
}

export function useBatchValidation(options: { source: string; sourceName: string; pack: HudStylePack; duration: number }) {
  const latest = useRef(options)
  latest.current = options
  const [state, setState] = useState<ValidationState>(EMPTY_VALIDATION_STATE)
  const session = useRef<BatchValidationSession | null>(null)
  const scan = useRef<ActiveScan | null>(null)
  const preview = useRef<AbortController | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    scan.current?.controller.abort()
    preview.current?.abort()
    scan.current = null
    preview.current = null
    session.current = null
    setState(EMPTY_VALIDATION_STATE)
    return () => {
      mounted.current = false
      scan.current?.controller.abort()
      preview.current?.abort()
      scan.current = null
      preview.current = null
    }
  }, [options.source])

  const stop = useCallback(() => {
    const active = scan.current
    if (!active || active.controller.signal.aborted) return
    active.stoppedRows = [...active.session.rows]
    active.controller.abort()
  }, [])
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
    const active: ActiveScan = { controller, session: next, stoppedRows: null }
    const source = latest.current.source
    scan.current = active
    setState({ ...EMPTY_VALIDATION_STATE, phase: 'running', run: next.run })
    let lastPaint = 0
    const current = (): boolean => mounted.current && session.current === next && scan.current === active && latest.current.source === source
    const finish = (phase: 'complete' | 'error', error?: unknown): void => {
      if (!current()) return
      // The runner settles only after releasing its decoder. Until then start/inspect stay locked.
      scan.current = null
      const stopped = controller.signal.aborted
      setState(value => ({ ...value, phase: stopped ? 'stopped' : phase,
        rows: active.stoppedRows ?? [...next.rows], error: stopped || phase === 'complete' ? null : error instanceof Error ? error.message : String(error) }))
    }
    void next.scan(controller.signal, () => {
      if (current() && !controller.signal.aborted && Date.now() - lastPaint >= 100) {
        lastPaint = Date.now()
        setState(value => ({ ...value, rows: [...next.rows] }))
      }
    }).then(() => finish('complete'), error => finish('error', error))
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
