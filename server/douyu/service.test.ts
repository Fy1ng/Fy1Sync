import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createDesktopService } from '../api'
import { resolveConfig } from '../config'
import { DouyuAccountManager } from '../../electron/douyuAccounts'
import { DouyuTaskManager } from '../../electron/douyuTasks'
import type { DouyuTaskDefinition, DouyuTaskOutcome } from './types'

const cleanups: Array<() => Promise<void>> = []
const accountId = '11111111-1111-4111-8111-111111111111'
function loginStub() {
  let loggedIn = false
  const empty = () => ({ loggedIn: false, cookieCount: 0, authKeysPresent: [] as string[], expiresAt: null, hasSessionCookies: false })
  return {
    login: vi.fn(async () => { loggedIn = true; return { cookieCount: 1, authKeysPresent: ['acf_uid'] } }),
    logout: vi.fn(async () => { loggedIn = false }),
    loginStatus: vi.fn(async () => ({ youtube: empty(), douyu: { ...empty(), loggedIn } })),
    cookieHeader: vi.fn(async () => ''), dispose: vi.fn(async () => {}),
  }
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-syncer-douyu-service-'))
  const defaultLogin = loginStub()
  const accounts = new DouyuAccountManager(root, {
    defaultLogin, createLogin: () => loginStub(), permissions: { protect() {}, verify() {} },
    store: { load: () => undefined, save() {} }, id: () => accountId,
  })
  const run = vi.fn(async (_task: DouyuTaskDefinition, _signal: AbortSignal): Promise<DouyuTaskOutcome> => ({ status: 'succeeded', message: 'synthetic result' }))
  const tasks = new DouyuTaskManager({ load: () => undefined, save() {}, run })
  tasks.setActiveAccount('default')
  tasks.setRoom('6979222')
  tasks.setRuntime({ foreground: true, locked: false, suspended: false })
  const release = accounts.subscribe(event => {
    if (event.type === 'invalidated') tasks.pauseAccount(event.accountId)
    tasks.setActiveAccount(accounts.activeAccountId)
  })
  const resolveRoom = vi.fn(async (inputRoom: string) => ({ ok: true as const, identity: { inputRoom, room: '6979222' } }))
  const service = createDesktopService({ dataDir: root, proxy: resolveConfig({}).proxy,
    registerMedia: () => '', resolveDouyuRoom: resolveRoom, douyuAccounts: accounts, douyuTasks: tasks })
  const result = { root, service, accounts, tasks, run, defaultLogin, release, resolveRoom }
  cleanups.push(async () => {
    release(); tasks.dispose(); service.dispose(); await accounts.dispose()
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('stream-syncer-douyu-service-')) throw new Error('Unexpected fixture directory')
    fs.rmSync(root, { recursive: true, force: true })
  })
  return result
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
const input = { accountId: 'default', roomInput: '6657', kind: 'room-sign', policy: 'foreground', repeatMinutes: null }

it('creates a paused task with the canonical room and requires login before dispatch', async () => {
  const f = fixture()
  const result = await f.service.invoke('createDouyuTask', input)
  expect(result).toMatchObject({ ok: true, value: { tasks: [{ room: '6979222', status: 'paused' }] } })
  const id = f.tasks.snapshot().tasks[0]!.id
  expect(f.run).not.toHaveBeenCalled()
  expect(await f.service.invoke('startDouyuTask', { id })).toMatchObject({ ok: false, code: 'login-required' })
  expect(f.run).not.toHaveBeenCalled()
  expect(await f.service.invoke('loginDouyuAccount', { id: 'default' })).toMatchObject({ ok: true })
  expect(await f.service.invoke('startDouyuTask', { id })).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1))
  expect(f.run.mock.calls[0]?.[0]).toMatchObject({ accountId: 'default', room: '6979222' })
})

it('pauses old-account tasks on activation and never silently transfers their ownership', async () => {
  const f = fixture()
  await f.service.invoke('createDouyuTask', input)
  const id = f.tasks.snapshot().tasks[0]!.id
  await f.accounts.login('default')
  let settle!: (value: DouyuTaskOutcome) => void
  f.run.mockImplementation(() => new Promise(resolve => { settle = resolve }))
  await f.service.invoke('startDouyuTask', { id })
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce())
  await f.service.invoke('addDouyuAccount', { label: '第二个' })
  expect(await f.service.invoke('activateDouyuAccount', { id: accountId })).toMatchObject({ ok: true })
  expect(f.tasks.snapshot().tasks[0]).toMatchObject({ accountId: 'default', status: 'paused' })
  settle({ status: 'succeeded', message: 'late' })
  await Promise.resolve()
  expect(await f.service.invoke('startDouyuTask', { id })).toMatchObject({ ok: false, code: 'no-active-account' })
})

it('removes the selected account and its task definitions only', async () => {
  const f = fixture()
  await f.accounts.add('第二个')
  await f.service.invoke('createDouyuTask', input)
  await f.service.invoke('createDouyuTask', { ...input, accountId })
  expect(await f.service.invoke('removeDouyuAccount', { id: accountId })).toMatchObject({ ok: true })
  expect(f.tasks.snapshot().tasks.map(task => task.accountId)).toEqual(['default'])
  expect(f.accounts.activeAccountId).toBe('default')
  expect(f.defaultLogin.logout).not.toHaveBeenCalled()
})

it('does not start new work while replacing the current login session', async () => {
  const f = fixture()
  await f.accounts.login('default')
  await f.service.invoke('createDouyuTask', input)
  const id = f.tasks.snapshot().tasks[0]!.id
  let settle!: (value: { cookieCount: number; authKeysPresent: string[] }) => void
  f.defaultLogin.login.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
  const login = f.accounts.login('default')
  expect(await f.service.invoke('startDouyuTask', { id })).toMatchObject({ ok: false, code: 'account-busy' })
  expect(f.run).not.toHaveBeenCalled()
  settle({ cookieCount: 1, authKeysPresent: ['acf_uid'] })
  await login
})

it.each([
  { ...input, cookie: 'synthetic' }, { ...input, kind: 'custom-code' },
  { ...input, repeatMinutes: 0 }, { ...input, repeatMinutes: 0.5 },
  { ...input, roomInput: {} }, { ...input, policy: 'always' },
])('rejects an invalid task before identity lookup or execution', async args => {
  const f = fixture()
  expect(await f.service.invoke('createDouyuTask', args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
  expect(f.resolveRoom).not.toHaveBeenCalled()
  expect(f.run).not.toHaveBeenCalled()
})

it('discards a room lookup after the service closes', async () => {
  const f = fixture()
  let settle!: (value: Awaited<ReturnType<typeof f.resolveRoom>>) => void
  f.resolveRoom.mockReturnValue(new Promise(resolve => { settle = resolve }))
  const pending = f.service.invoke('createDouyuTask', input)
  f.service.dispose()
  settle({ ok: true, identity: { inputRoom: '6657', room: '6979222' } })
  expect(await pending).toMatchObject({ ok: false, code: 'service-closed' })
  expect(f.tasks.snapshot().tasks).toHaveLength(0)
})
