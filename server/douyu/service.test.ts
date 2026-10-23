import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createDesktopService } from '../api'
import { resolveConfig } from '../config'
import { DouyuAccountManager } from '../../electron/douyuAccounts'
import { DouyuTaskManager } from '../../electron/douyuTasks'
import type { DouyuMessageInput, DouyuMessageOutcome, DouyuTaskDefinition, DouyuTaskOutcome } from './types'

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
  const sendMessage = vi.fn(async (_input: DouyuMessageInput, _signal: AbortSignal): Promise<DouyuMessageOutcome> => ({ status: 'succeeded', message: 'synthetic receipt', nextAllowedAt: null }))
  const tasks = new DouyuTaskManager({ load: () => undefined, save() {}, run, sendMessage })
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
  const result = { root, service, accounts, tasks, run, sendMessage, defaultLogin, release, resolveRoom }
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
const messageInput: DouyuMessageInput = { accountId: 'default', room: '6979222', text: '加油 @A/原文', color: 0 }

it('sends only for a logged-in active account in the current canonical room', async () => {
  const f = fixture()
  expect(await f.service.invoke('sendDouyuMessage', messageInput)).toMatchObject({ ok: false, code: 'login-required' })
  await f.accounts.login('default')
  expect(await f.service.invoke('sendDouyuMessage', { ...messageInput, accountId })).toMatchObject({ ok: false, code: 'no-active-account' })
  expect(await f.service.invoke('sendDouyuMessage', { ...messageInput, room: '6657' })).toMatchObject({ ok: false, code: 'room-changed' })
  expect(f.sendMessage).not.toHaveBeenCalled()
  expect(await f.service.invoke('sendDouyuMessage', messageInput)).toMatchObject({ ok: true, value: { status: 'succeeded', message: 'synthetic receipt' } })
  expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith(messageInput, expect.any(AbortSignal))
  expect(f.tasks.snapshot().tasks).toEqual([])
  expect(f.resolveRoom).not.toHaveBeenCalled()
})

it.each([
  { ...messageInput, url: 'https://other.example/' }, { ...messageInput, cookie: 'synthetic' },
  { ...messageInput, room: 'https://www.douyu.com/6979222' }, { ...messageInput, room: '001' },
  { ...messageInput, text: '' }, { ...messageInput, text: '  ' }, { ...messageInput, text: 'a'.repeat(501) },
  { ...messageInput, color: -1 }, { ...messageInput, color: 7 }, { ...messageInput, color: '0' },
])('rejects invalid message arguments before authentication or dispatch', async args => {
  const f = fixture()
  expect(await f.service.invoke('sendDouyuMessage', args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
  expect(f.defaultLogin.loginStatus).not.toHaveBeenCalled()
  expect(f.sendMessage).not.toHaveBeenCalled()
})

it('does not send a late authentication result into a room that was left', async () => {
  const f = fixture()
  await f.accounts.login('default')
  let settle!: (value: Awaited<ReturnType<typeof f.accounts.activeLoginStatus>>) => void
  vi.spyOn(f.accounts, 'activeLoginStatus').mockReturnValueOnce(new Promise(resolve => { settle = resolve }))
  const pending = f.service.invoke('sendDouyuMessage', messageInput)
  f.tasks.setRoom('288016')
  settle({ loggedIn: true, cookieCount: 1, authKeysPresent: [], expiresAt: null, hasSessionCookies: true })
  expect(await pending).toMatchObject({ ok: true, value: { status: 'failed' } })
  expect(f.sendMessage).not.toHaveBeenCalled()
})

it('cancels an in-flight send when the account is logged out and ignores its late success', async () => {
  const f = fixture()
  await f.accounts.login('default')
  let settle!: (value: DouyuMessageOutcome) => void
  f.sendMessage.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
  const pending = f.service.invoke('sendDouyuMessage', messageInput)
  await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledOnce())
  await f.service.invoke('logoutDouyuAccount', { id: 'default' })
  expect(await pending).toMatchObject({ ok: true, value: { status: 'waiting-user' } })
  expect(f.sendMessage.mock.calls[0]?.[1].aborted).toBe(true)
  settle({ status: 'succeeded', message: 'late receipt', nextAllowedAt: null })
  expect(f.tasks.snapshot().tasks).toEqual([])
})

it('routes Yuba login through the selected account and keeps Yuba tasks separate', async () => {
  const f = fixture()
  expect(await f.service.invoke('loginDouyuYubaAccount', { id: 'default', url: 'https://other.example/' }))
    .toMatchObject({ ok: false, code: 'invalid-arguments' })
  expect(f.defaultLogin.login).not.toHaveBeenCalled()
  expect(await f.service.invoke('loginDouyuYubaAccount', { id: 'default' })).toMatchObject({ ok: true })
  expect(f.defaultLogin.login).toHaveBeenCalledExactlyOnceWith('douyu', 'yuba')
  await f.service.invoke('createDouyuTask', input)
  expect(await f.service.invoke('createDouyuTask', { ...input, kind: 'yuba-sign' }))
    .toMatchObject({ ok: true, value: { tasks: [{ kind: 'room-sign' }, { kind: 'yuba-sign', status: 'paused' }] } })
  const id = f.tasks.snapshot().tasks[1]!.id
  expect(f.run).not.toHaveBeenCalled()
  expect(await f.service.invoke('startDouyuTask', { id })).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce())
  expect(f.run.mock.calls[0]?.[0]).toMatchObject({ accountId: 'default', room: '6979222', kind: 'yuba-sign' })
})

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
