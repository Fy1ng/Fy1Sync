import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ApiResult } from '../../app/apiClient'
import { displayError, type ErrorDetails } from '../../core/errorDetails'

export interface Lane {
  pending: string
  notice: string
  error: string
  errorDetail?: ErrorDetails
}

export const IDLE: Lane = { pending: '', notice: '', error: '' }

export function failedLane(error: unknown, summary?: string): Lane {
  const shown = displayError(error, summary)
  return { ...IDLE, error: shown.message, errorDetail: shown.detail }
}

type Task = { id: string }
type TaskSnapshot = { tasks: Task[] }
type Work<Value> = () => Promise<ApiResult<Value>>
type Report = (lane: Lane, rowId?: string) => void
type Removal<Row> = { task: Row; beforeId?: string }

export function withTaskWrites<Value>(enabled: () => boolean, start: Work<Value>): Promise<ApiResult<Value>> {
  return enabled() ? start() : Promise.resolve({ ok: false, code: 'douyu-writes-disabled', message: '请先开启斗鱼写操作' })
}

export function useTaskActions<Snapshot extends TaskSnapshot>({ snapshot, valid, apply, revision, mounted, invalidMessage }: {
  snapshot: Snapshot | null
  valid: (value: unknown) => value is Snapshot
  apply: (value: Snapshot | null) => void
  revision: RefObject<number>
  mounted: RefObject<boolean>
  invalidMessage: string
}) {
  type Row = Snapshot['tasks'][number]
  const [lane, setLane] = useState<Lane>(IDLE)
  const [feedback, setFeedback] = useState(new Map<string, { lane: Lane; removal?: Removal<Row> }>())
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer)
    timers.current.clear()
  }, [])

  const dismiss = (id: string): void => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setFeedback((current) => {
      const next = new Map(current)
      next.delete(id)
      return next
    })
  }

  const run = async (work: (report: Report) => Promise<boolean>, rowId?: string, removal?: Removal<Row>): Promise<boolean> => {
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(true)
    const report: Report = (nextLane, id = rowId) => {
      if (!mounted.current) return
      if (id === undefined) { setLane(nextLane); return }
      clearTimeout(timers.current.get(id))
      timers.current.delete(id)
      setFeedback((current) => new Map(current).set(id, { lane: nextLane, removal }))
      if (nextLane.notice) timers.current.set(id, setTimeout(() => dismiss(id), 3000))
    }
    try { return await work(report) }
    catch (error) { report(failedLane(error, '操作未完成，请重试')); return false }
    finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const request = async (work: Work<Snapshot>): Promise<{ value: Snapshot } | { failure: Lane }> => {
    const before = revision.current
    try {
      const result = await work()
      if (!result.ok) return { failure: failedLane(result) }
      if (!valid(result.value)) return { failure: failedLane(result, invalidMessage) }
      if (mounted.current) apply(before === revision.current ? result.value : null)
      return { value: result.value }
    } catch (error) {
      return { failure: failedLane(error, '操作未完成，请重试') }
    }
  }

  const act = (pending: string, work: Work<Snapshot>, done: string, rowId?: string, removal?: Removal<Row>): Promise<boolean> =>
    run(async (report) => {
      report({ ...IDLE, pending })
      const result = await request(work)
      report('failure' in result ? result.failure : { ...IDLE, notice: done })
      return !('failure' in result)
    }, rowId, removal)

  const add = (work: Work<Snapshot>, start?: (task: Row) => Promise<ApiResult<Snapshot>>): Promise<boolean> =>
    run(async (report) => {
      report({ ...IDLE, pending: '正在添加' })
      const created = await request(work)
      if ('failure' in created) { report(created.failure); return false }
      if (!start) { report({ ...IDLE, notice: '已添加' }); return true }

      // Both create handlers append the new task before returning their snapshot.
      const added: Row | undefined = created.value.tasks.at(-1)
      if (!added || snapshot?.tasks.some((task) => task.id === added.id)) {
        report({ ...IDLE, error: '已添加，但未能启动：未找到新增任务' })
        return true
      }
      report(IDLE)
      report({ ...IDLE, pending: '正在启动' }, added.id)
      const started = await request(() => start(added))
      report('failure' in started
        ? { ...started.failure, error: `已添加，但未能启动：${started.failure.error}` }
        : { ...IDLE, notice: '已启动' }, added.id)
      return true
    })

  const rows = (snapshot?.tasks ?? []).map((task: Row) => ({ task, removed: false }))
  for (const [id, { removal }] of [...feedback].reverse()) {
    if (!removal || rows.some(({ task }) => task.id === id)) continue
    const index = rows.findIndex(({ task }) => task.id === removal.beforeId)
    rows.splice(index < 0 ? rows.length : index, 0, { task: removal.task, removed: true })
  }
  const remove = (task: Row, work: Work<Snapshot>): Promise<boolean> =>
    act('正在删除', work, '已删除', task.id, { task, beforeId: rows[rows.findIndex(row => row.task.id === task.id) + 1]?.task.id })

  return { lane, busy, rows, act, add, remove, run, dismiss, rowLane: (id: string) => feedback.get(id)?.lane ?? IDLE }
}
