/**
 * 斗鱼写操作 is off until the viewer confirms the risk.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { DEFAULT_SETTINGS, mergeSettings } from '../app/settings'
import { DouyuWritesPane } from './douyuWrites'

const sessions: Session[] = []
let rooms: { id: string; status: string; nextRunAt: number | null }[] = []
let batches: typeof rooms = []
let failPause = false
let failRead = false
let finishPause: (() => void) | null = null
let waitPause = false
let paused: string[] = []

beforeEach(() => {
  rooms = []; batches = []; paused = []; failPause = false; failRead = false; waitPause = false; finishPause = null
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => {
      if (failRead && method === 'getDouyuTasks') return { ok: false, code: 'read-failed', message: '读取失败' }
      if (method === 'getDouyuTasks') return { ok: true, value: { tasks: rooms } }
      if (method === 'getDouyuAutomations') return { ok: true, value: { tasks: batches } }
      if (method === 'pauseDouyuTask' || method === 'pauseDouyuAutomation') {
        if (failPause) return { ok: false, code: 'pause-failed', message: '暂停失败' }
        if (waitPause) await new Promise<void>(resolve => { finishPause = resolve })
        const id = (args as { id: string }).id
        paused.push(id)
        const tasks = method === 'pauseDouyuTask' ? rooms : batches
        const task = tasks.find(item => item.id === id)!
        task.status = 'paused'; task.nextRunAt = null
        return { ok: true, value: { tasks } }
      }
      return { ok: false, code: 'unexpected', message: 'unexpected' }
    }) as unknown as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
})
afterEach(() => {
  cleanup()
  for (const session of sessions.splice(0)) session.dispose()
  localStorage.clear()
  vi.unstubAllGlobals()
})

function renderPane(): Session {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  render(<SessionProvider session={session}><DouyuWritesPane /></SessionProvider>)
  return session
}

describe('斗鱼写操作', () => {
  it('is off by default and only a boolean turns it on', () => {
    expect(DEFAULT_SETTINGS.douyuWrites).toBe(false)
    expect(mergeSettings({}).douyuWrites).toBe(false)
    expect(mergeSettings({ douyuWrites: 'yes' } as unknown).douyuWrites).toBe(false)
    expect(mergeSettings({ douyuWrites: true }).douyuWrites).toBe(true)
  })

  it('asks before turning on, and cancel leaves it off', () => {
    const session = renderPane()
    const toggle = screen.getByRole('switch', { name: /^斗鱼写操作/ })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    expect(session.settings.douyuWrites).toBe(false)
    expect(screen.getByRole('group', { name: '确认打开斗鱼写操作' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(session.settings.douyuWrites).toBe(false)
    expect(screen.getByRole('switch', { name: /^斗鱼写操作/ })).not.toBeChecked()
  })

  it('turns on after confirming and off again in one click when no tasks are running', async () => {
    const session = renderPane()
    fireEvent.click(screen.getByRole('switch', { name: /^斗鱼写操作/ }))
    fireEvent.click(screen.getByRole('button', { name: '确认打开' }))
    expect(session.settings.douyuWrites).toBe(true)
    await waitFor(() => expect(screen.getByRole('switch', { name: /^斗鱼写操作/ })).toBeChecked())
    fireEvent.click(screen.getByRole('switch', { name: /^斗鱼写操作/ }))
    await waitFor(() => expect(session.settings.douyuWrites).toBe(false))
  })

  it('counts active, queued and scheduled room and batch tasks and leaves them running on cancel', async () => {
    rooms = [{ id: 'r1', status: 'running', nextRunAt: null }, { id: 'r2', status: 'succeeded', nextRunAt: 10 }, { id: 'r3', status: 'paused', nextRunAt: null }]
    batches = [{ id: 'b1', status: 'queued', nextRunAt: null }]
    const session = renderPane()
    session.updateSettings({ douyuWrites: true })
    await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
    fireEvent.click(screen.getByRole('switch'))
    const confirmation = await screen.findByRole('group', { name: '确认关闭斗鱼写操作' })
    expect(confirmation).toHaveTextContent('有 3 个任务')
    expect(session.settings.douyuWrites).toBe(true)
    expect(paused).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(session.settings.douyuWrites).toBe(true)
    expect(paused).toEqual([])
  })

  it('pauses every active task before disabling and includes tasks added before confirmation', async () => {
    rooms = [{ id: 'r1', status: 'running', nextRunAt: null }, { id: 'r2', status: 'succeeded', nextRunAt: 10 }]
    batches = [{ id: 'b1', status: 'queued', nextRunAt: null }]
    const session = renderPane()
    session.updateSettings({ douyuWrites: true })
    await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
    fireEvent.click(screen.getByRole('switch'))
    await screen.findByRole('group', { name: '确认关闭斗鱼写操作' })
    batches.push({ id: 'b2', status: 'queued', nextRunAt: null })
    fireEvent.click(screen.getByRole('button', { name: '全部暂停并关闭' }))
    await waitFor(() => expect(session.settings.douyuWrites).toBe(false))
    expect(paused.sort()).toEqual(['b1', 'b2', 'r1', 'r2'])
    expect([...rooms, ...batches].every(task => task.status === 'paused' && task.nextRunAt === null)).toBe(true)
  })

  it('keeps the write gate enabled while pause is pending', async () => {
    rooms = [{ id: 'r1', status: 'running', nextRunAt: null }]
    waitPause = true
    const session = renderPane()
    session.updateSettings({ douyuWrites: true })
    await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
    fireEvent.click(screen.getByRole('switch'))
    await screen.findByRole('group', { name: '确认关闭斗鱼写操作' })
    fireEvent.click(screen.getByRole('button', { name: '全部暂停并关闭' }))
    await waitFor(() => expect(finishPause).not.toBeNull())
    expect(session.settings.douyuWrites).toBe(true)
    finishPause!()
    await waitFor(() => expect(session.settings.douyuWrites).toBe(false))
  })

  it('keeps the gate and confirmation when pausing fails and retries in place', async () => {
    batches = [{ id: 'b1', status: 'running', nextRunAt: null }]
    failPause = true
    const session = renderPane()
    session.updateSettings({ douyuWrites: true })
    await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
    fireEvent.click(screen.getByRole('switch'))
    await screen.findByRole('group', { name: '确认关闭斗鱼写操作' })
    fireEvent.click(screen.getByRole('button', { name: '全部暂停并关闭' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('关闭未完成')
    expect(session.settings.douyuWrites).toBe(true)
    failPause = false
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(session.settings.douyuWrites).toBe(false))
    expect(paused).toEqual(['b1'])
  })

  it('keeps the gate enabled when the task count cannot be read and retries', async () => {
    failRead = true
    const session = renderPane()
    session.updateSettings({ douyuWrites: true })
    await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
    fireEvent.click(screen.getByRole('switch'))
    expect(await screen.findByRole('alert')).toHaveTextContent('关闭未完成')
    expect(session.settings.douyuWrites).toBe(true)
    expect(screen.queryByRole('group', { name: '确认关闭斗鱼写操作' })).toBeNull()
    failRead = false
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(session.settings.douyuWrites).toBe(false))
  })
})
