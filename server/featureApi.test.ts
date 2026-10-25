import { describe, expect, it, vi } from 'vitest'
import { FeatureApi, FeatureApiError, createDanmakuHandlers, createFeatureAccountGuard, createInsightsHandlers,
  type FeatureHandlers, type InsightsHandlerDependencies, type WithFeatureAccount } from './featureApi'
import { DanmakuFeatures, type FavoriteDanmaku } from '../electron/danmakuFeatures'
import { DouyuTaskError } from '../electron/douyuTasks'
import type { FeatureCallContext, FeatureEvent } from '../electron/featureContracts'
import type { DouyuMessageOutcome, DouyuTasksSnapshot } from './douyu/types'
import { DouyuInsightsService } from './douyu/insightsService'
import type { DouyuBadgeAges, DouyuFollowedRooms, DouyuMonthlySpending, DouyuRoomInfo, DouyuWatchTime } from './douyu/insightsTypes'
import type { AppUpdateState } from '../electron/appUpdateService'

const OTHER_ACCOUNT = '00000000-0000-4000-8000-000000000001'
const now = 1_790_000_000_000
const loginStatus = (loggedIn = true) => ({ loggedIn, cookieCount: 1, authKeysPresent: ['acf_auth'], expiresAt: null, hasSessionCookies: true })
const passAccount: WithFeatureAccount = async (_id, run) => run(new AbortController().signal)
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function danmakuFixture(withAccount: WithFeatureAccount = passAccount) {
  let nextId = 0
  const save = vi.fn()
  const features = new DanmakuFeatures({ load: () => undefined, save, now: () => now, id: () => 'favorite-' + ++nextId })
  const snapshot: DouyuTasksSnapshot = { activeAccountId: 'default', currentRoom: '100', retainedRooms: [], tasks: [],
    runtime: { foreground: true, locked: false, suspended: false } }
  const sent: DouyuMessageOutcome = { status: 'succeeded', message: 'Accepted', nextAllowedAt: null, gatewayAccepted: true }
  const tasks = { snapshot: () => snapshot, sendMessage: vi.fn(async () => sent) }
  const moderation = {
    preflight: vi.fn(async () => ({ allowed: true, code: 'allowed' as const, message: 'Allowed' })),
    mute: vi.fn(async () => ({ status: 'succeeded' as const, code: 'receipt-confirmed' as const, message: 'Confirmed', submitted: true })),
  }
  const openExternal = vi.fn()
  const api = new FeatureApi(createDanmakuHandlers({ features, tasks, moderation, withAccount, openExternal }))
  return { api, features, save, tasks, snapshot, moderation, openExternal }
}

function insightsFixture(withAccount: WithFeatureAccount = passAccount) {
  const followed: DouyuFollowedRooms = { accountId: 'default', checkedAt: now, coverage: 'all-pages', pageCount: 1, rooms: [], reason: null }
  const badgeAges: DouyuBadgeAges = { accountId: 'default', checkedAt: now, coverage: 'returned-page', badges: [] }
  const spending: DouyuMonthlySpending = { accountId: 'default', checkedAt: now, month: '2026-10', timeZone: 'Asia/Shanghai',
    currency: 'CNY', unit: 'fen', sources: [], totalMinor: null, aggregation: 'partial', message: 'No fixture ledger' }
  const watch: DouyuWatchTime = { accountId: 'default', room: '100', checkedAt: now, seconds: 120, source: 'douyu-today-watch' }
  const gateway: NonNullable<InsightsHandlerDependencies['gateway']> = {
    readFollowedRooms: vi.fn(async () => followed), readBadgeAges: vi.fn(async () => badgeAges),
    readMonthlySpending: vi.fn(async () => spending), readWatchTime: vi.fn(async () => watch),
  }
  const info: DouyuRoomInfo = { room: '100', checkedAt: now, roomName: 'Fixture room', nickname: 'Fixture owner', ownerUid: '99',
    live: true, replay: false, startedAt: now - 5_000, lastStartedAt: null, popularity: 1_000, viewers: null, source: 'douyu-h5room' }
  const readRoom = vi.fn(async () => info)
  const service = new DouyuInsightsService({ gateway: { readRoom, readFollowedRooms: gateway.readFollowedRooms }, now: () => now })
  const insights = {
    snapshot: vi.fn((room: string) => service.snapshot(room)),
    refreshRoom: vi.fn((room: string, signal: AbortSignal) => service.refreshRoom(room, signal)),
    reportPlayback: vi.fn((room: string, playing: boolean, sessionId?: string) => service.reportPlayback(room, playing, sessionId)),
    setNotifications: vi.fn(), startFollowMonitor: vi.fn(), stopFollowMonitor: vi.fn(),
  }
  const state: AppUpdateState = { phase: 'unconfigured', currentVersion: '0.1.3', latestVersion: null, releaseUrl: null,
    releaseNotes: null, checkedAt: null, message: 'No update source configured' }
  const update = { check: vi.fn(async () => state), state: vi.fn(() => state) }
  const lifetime = new AbortController()
  const api = new FeatureApi(createInsightsHandlers({ insights, gateway, update, withAccount, lifetime: lifetime.signal }))
  return { api, gateway, insights, readRoom, service, lifetime, update, followed, badgeAges, spending, watch,
    dispose: () => { lifetime.abort(); api.dispose(); service.dispose() } }
}

function accountsFixture() {
  type Port = Parameters<typeof createFeatureAccountGuard>[0]
  type Listener = Parameters<Port['subscribe']>[0]
  type Event = Parameters<Listener>[0]
  const state = { active: 'default' as string | null, busy: false }
  const listeners = new Set<Listener>()
  const activeLoginStatus = vi.fn(async () => loginStatus())
  const releases = vi.fn()
  const accounts: Port = {
    get activeAccountId() { return state.active }, isBusy: () => state.busy, activeLoginStatus,
    subscribe: listener => { listeners.add(listener); return () => { releases(); listeners.delete(listener) } },
  }
  return { state, accounts, activeLoginStatus, listeners, releases,
    emit: (event: Event) => { for (const listener of [...listeners]) listener(event) } }
}

describe('typed feature dispatch and safe public failures', () => {
  it('registers only explicit feature methods, supports composition and rejects reserved IPC operations', async () => {
    const f = danmakuFixture()
    expect(f.api.has('getDanmakuFeatures')).toBe(true)
    expect(await f.api.invoke('getDanmakuFeatures', undefined)).toMatchObject({ ok: true, value: { favoriteCount: 0 } })
    const secondary = insightsFixture()
    f.api.register(createInsightsHandlers({ update: secondary.update, withAccount: passAccount }))
    expect(await f.api.invoke('getAppUpdateState', undefined)).toMatchObject({ ok: true, value: { phase: 'unconfigured' } })
    for (const name of ['constructor', 'toString', '__proto__', 'cookieHeader', 'activateDouyuRoom']) {
      expect(f.api.has(name)).toBe(false)
      expect(await f.api.invoke(name, undefined)).toMatchObject({ code: 'not-found' })
    }
    expect(() => f.api.register('activateDouyuRoom', args => args)).toThrow(FeatureApiError)
    expect(() => f.api.register({ unsafeMethod: () => 'private' } as unknown as FeatureHandlers)).toThrow(FeatureApiError)
    secondary.dispose()
    f.api.dispose()
  })

  it('does not partly install malformed maps or evaluate getters when registering them', async () => {
    const api = new FeatureApi()
    const getter = vi.fn(() => () => ({}))
    const handlers = Object.defineProperty({}, 'getDanmakuFeatures', { enumerable: true, get: getter })
    expect(() => api.register(handlers as FeatureHandlers)).toThrow(FeatureApiError)
    expect(getter).not.toHaveBeenCalled()
    expect(() => api.register({ getDanmakuFeatures: () => ({}), unsafeMethod: () => ({}) } as unknown as FeatureHandlers)).toThrow(FeatureApiError)
    expect(api.has('getDanmakuFeatures')).toBe(false)
    api.dispose()
  })

  it('rejects extra caller context and freezes a valid sender identity', async () => {
    const f = danmakuFixture()
    let captured: FeatureCallContext | undefined
    f.api.register('getDanmakuFeatures', (_args, context) => { captured = context; return f.features.snapshot() })
    await f.api.invoke('getDanmakuFeatures', undefined, { senderId: 9 })
    expect(captured).toEqual({ senderId: 9 })
    expect(Object.isFrozen(captured)).toBe(true)
    for (const senderId of [-1, 0, 1.2, NaN, '9']) expect(await f.api.invoke('getDanmakuFeatures', undefined, { senderId } as FeatureCallContext)).toMatchObject({ code: 'forbidden' })
    expect(await f.api.invoke('getDanmakuFeatures', undefined, { senderId: 9, role: 'main' } as FeatureCallContext)).toMatchObject({ code: 'invalid-arguments' })
    f.api.dispose()
  })

  it.each([
    [new DouyuTaskError('task-not-found', 'DO_NOT_EXPORT custom error detail'), 'task-not-found'],
    [Object.assign(new Error('DO_NOT_EXPORT upstream response'), { code: 'price-changed' }), 'price-changed'],
    [Object.assign(new Error('DO_NOT_EXPORT local path'), { code: 'capture-failed' }), 'capture-failed'],
    [new DOMException('DO_NOT_EXPORT abort reason', 'AbortError'), 'cancelled'],
    [new Error('DO_NOT_EXPORT raw exception'), 'internal-error'],
    [Object.assign(new Error('DO_NOT_EXPORT unknown code'), { code: 'DO_NOT_EXPORT' }), 'internal-error'],
  ])('returns only fixed public text for %s', async (error, code) => {
    const api = new FeatureApi({ getDanmakuFeatures: () => { throw error } })
    const result = await api.invoke('getDanmakuFeatures', undefined)
    expect(result).toMatchObject({ ok: false, code })
    expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPORT')
    api.dispose()
  })

  it('does not evaluate exception accessors or proxies while constructing public errors', async () => {
    const getter = vi.fn(() => { throw new Error('DO_NOT_EXPORT') })
    const error = Object.defineProperties(new Error(), { code: { get: getter }, name: { get: getter }, message: { get: getter } })
    const api = new FeatureApi({ getDanmakuFeatures: () => { throw error } })
    expect(await api.invoke('getDanmakuFeatures', undefined)).toMatchObject({ code: 'internal-error' })
    const proxy = new Proxy(new Error(), { getPrototypeOf: getter })
    api.register('getDanmakuFeatures', () => { throw proxy })
    expect(await api.invoke('getDanmakuFeatures', undefined)).toMatchObject({ code: 'internal-error' })
    expect(getter).not.toHaveBeenCalled()
    api.dispose()
  })

  it('isolates event listener mutations and exceptions and releases listeners on disposal', () => {
    const api = new FeatureApi()
    const event: FeatureEvent = { topic: 'pip', data: { ready: true } }
    const throwing = vi.fn((value: FeatureEvent) => { (value.data as { ready: boolean }).ready = false; throw new Error('closed view') })
    const receiving = vi.fn()
    api.subscribe(throwing)
    const release = api.subscribe(receiving)
    api.publish(event)
    expect(receiving).toHaveBeenCalledExactlyOnceWith(event)
    expect(event.data).toEqual({ ready: true })
    release(); release()
    api.publish(event)
    expect(receiving).toHaveBeenCalledTimes(1)
    expect(() => api.publish({ topic: '../private', data: {} })).toThrow(FeatureApiError)
    api.dispose(); api.dispose()
    api.publish(event)
    expect(throwing).toHaveBeenCalledTimes(2)
  })

  it('discards in-flight results and refuses registration after disposal', async () => {
    const wait = deferred<ReturnType<DanmakuFeatures['snapshot']>>()
    const api = new FeatureApi({ getDanmakuFeatures: () => wait.promise })
    const pending = api.invoke('getDanmakuFeatures', undefined)
    api.dispose()
    wait.resolve(danmakuFixture().features.snapshot())
    expect(await pending).toMatchObject({ code: 'service-closed' })
    expect(await api.invoke('getDanmakuFeatures', undefined)).toMatchObject({ code: 'service-closed' })
    expect(() => api.register({})).toThrow(FeatureApiError)
    expect(api.has('getDanmakuFeatures')).toBe(false)
  })
})

describe('Danmaku feature handlers', () => {
  it('routes settings, bounded history, favorites and public user details through existing services', async () => {
    const f = danmakuFixture()
    await f.api.invoke('setDanmakuPreferences', { verticalGapPx: 14, showUserDetails: true })
    const added = await f.api.invoke('addDanmakuFavorite', { room: '100', uid: '9007199254740993', username: 'Viewer', text: 'hello' })
    expect(added.ok).toBe(true)
    const favorite = (added as { ok: true; value: FavoriteDanmaku }).value
    await f.api.invoke('updateDanmakuFavorite', { id: favorite.id, text: 'updated' })
    expect(await f.api.invoke('queryDanmakuFavorites', { room: '100', query: 'updated', pageSize: 1 })).toMatchObject({ ok: true, value: { total: 1 } })
    f.features.observe({ id: 'message-1', room: '100', receivedAt: now, text: 'received', username: 'Viewer',
      color: 0, level: 1, system: false, sender: { uid: '9007199254740993' } })
    expect(await f.api.invoke('queryDanmakuHistory', { room: '100', uid: '9007199254740993' })).toMatchObject({ ok: true, value: { total: 1, coverage: 'received-only' } })
    expect(await f.api.invoke('getDanmakuUserDetails', { room: '100', uid: '9007199254740993' })).toMatchObject({ ok: true, value: { uid: '9007199254740993', username: 'Viewer' } })
    expect(await f.api.invoke('getDanmakuRate', { room: '100' })).toMatchObject({ ok: true, value: { receivedLastMinute: 1 } })
    expect(await f.api.invoke('removeDanmakuFavorite', { id: favorite.id })).toEqual({ ok: true, value: { removed: true } })
    expect(f.features.snapshot()).toMatchObject({ favoriteCount: 0, preferences: { verticalGapPx: 14 } })
    f.api.dispose()
  })

  it('accepts only bounded structured fields and never evaluates argument accessors', async () => {
    const f = danmakuFixture()
    const getter = vi.fn(() => '9007199254740993')
    const accessor = Object.defineProperty({ room: '100' }, 'uid', { enumerable: true, get: getter })
    expect(await f.api.invoke('getDanmakuUserDetails', accessor)).toMatchObject({ code: 'invalid-arguments' })
    expect(getter).not.toHaveBeenCalled()
    const cases: Array<[string, unknown]> = [
      ['getDanmakuFeatures', {}], ['queryDanmakuHistory', { pageSize: 201 }], ['queryDanmakuHistory', { uid: '0' }],
      ['queryDanmakuFavorites', { query: 'a'.repeat(201) }], ['addDanmakuFavorite', { text: 'a'.repeat(2_001) }],
      ['addDanmakuFavorite', { text: 'saved', cookie: 'renderer-claim' }], ['updateDanmakuFavorite', { id: '', text: 'saved' }],
      ['removeDanmakuFavorite', { id: 'missing', extra: true }], ['getDanmakuRate', { room: 'https://www.douyu.com/100' }],
      ['setDanmakuPreferences', { verticalGapPx: 65 }], ['setMessageAffixes', { cookie: 'renderer-claim' }],
    ]
    for (const [method, args] of cases) expect(await f.api.invoke(method, args)).toMatchObject({ code: 'invalid-arguments' })
    expect(f.save).not.toHaveBeenCalled()
    f.api.dispose()
  })

  it('opens only generated history URLs, never caller-provided URLs', async () => {
    const f = danmakuFixture()
    expect(await f.api.invoke('openDanmakuHistory', { uid: '123' })).toEqual({ ok: true, value: { opened: true } })
    expect(f.openExternal).toHaveBeenCalledExactlyOnceWith(f.features.externalHistoryUrl('123'))
    for (const args of [{ uid: 'https://untrusted.invalid/' }, { uid: '123', url: 'https://untrusted.invalid/' }]) {
      expect(await f.api.invoke('openDanmakuHistory', args)).toMatchObject({ code: 'invalid-arguments' })
    }
    expect(f.openExternal).toHaveBeenCalledTimes(1)
    f.api.dispose()
  })

  it('composes normal sends, preserves repeats and checks the active room before dispatch', async () => {
    const f = danmakuFixture()
    await f.api.invoke('setMessageAffixes', { enabled: true, prefix: '[', suffix: ']' })
    const input = { accountId: 'default', room: '100', text: 'message', color: 2 }
    expect(await f.api.invoke('sendComposedDouyuMessage', input)).toMatchObject({ ok: true, value: { gatewayAccepted: true } })
    expect(f.tasks.sendMessage).toHaveBeenLastCalledWith({ ...input, text: '[message]' })
    await f.api.invoke('sendComposedDouyuMessage', { ...input, mode: 'repeat' })
    expect(f.tasks.sendMessage).toHaveBeenLastCalledWith(input)
    f.snapshot.currentRoom = '200'
    expect(await f.api.invoke('sendComposedDouyuMessage', input)).toMatchObject({ code: 'room-changed' })
    expect(f.tasks.sendMessage).toHaveBeenCalledTimes(2)
    f.api.dispose()
  })

  it('validates moderation fields and account context before its existing authorization checks', async () => {
    const signals: AbortSignal[] = []
    const accountIds: string[] = []
    const f = danmakuFixture(async (id, run) => {
      accountIds.push(id)
      const controller = new AbortController()
      signals.push(controller.signal)
      return run(controller.signal)
    })
    const target = { accountId: 'default', room: '100' }
    const input = { ...target, username: 'Viewer', minutes: 10 }
    expect(await f.api.invoke('previewDouyuMute', target)).toMatchObject({ ok: true, value: { allowed: true } })
    expect(f.moderation.preflight).toHaveBeenCalledWith(target, signals[0])
    expect(await f.api.invoke('muteDouyuUser', input)).toMatchObject({ ok: true, value: { submitted: true } })
    expect(f.moderation.mute).toHaveBeenCalledExactlyOnceWith(input, signals[1])
    for (const args of [{ ...input, minutes: 2 }, { ...input, minutes: -1 }, { ...input, username: '\u202eViewer' },
      { ...input, accountId: 'not-an-account' }, { ...input, credentials: 'renderer-claim' }]) {
      expect(await f.api.invoke('muteDouyuUser', args)).toMatchObject({ code: 'invalid-arguments' })
    }
    expect(accountIds).toEqual(['default', 'default'])
    expect(f.moderation.mute).toHaveBeenCalledTimes(1)
    f.api.dispose()
  })

  it('keeps delivery evidence bound to the selected account', async () => {
    const f = danmakuFixture()
    const own = f.features.deliveries.begin({ accountId: 'default', room: '100', uid: '123', text: 'hello' })
    const other = f.features.deliveries.begin({ accountId: OTHER_ACCOUNT, room: '100', uid: '456', text: 'private' })
    expect(await f.api.invoke('getDouyuDelivery', { accountId: 'default', id: own })).toMatchObject({ ok: true, value: { accountId: 'default' } })
    expect(await f.api.invoke('getDouyuDelivery', { accountId: 'default', id: other })).toEqual({ ok: true, value: null })
    const ownResult = await f.api.invoke('getDouyuDelivery', { accountId: 'default', id: own })
    expect(JSON.stringify(ownResult)).not.toMatch(/"uid"|"text"|"credentials"/)
    f.api.dispose()
  })
})

describe('insights, playback and update handlers', () => {
  it('routes sensitive queries through the selected account guard and only fixed gateway methods', async () => {
    const calls: Array<{ id: string; signal: AbortSignal }> = []
    const f = insightsFixture(async (id, run) => {
      const signal = new AbortController().signal
      calls.push({ id, signal })
      return run(signal)
    })
    const cases = [
      ['getDouyuFollowedRooms', 'readFollowedRooms'], ['getDouyuBadgeAges', 'readBadgeAges'],
      ['getDouyuMonthlySpending', 'readMonthlySpending'], ['getDouyuWatchTime', 'readWatchTime'],
    ] as const
    for (const [method, gatewayMethod] of cases) {
      const args = method === 'getDouyuWatchTime' ? { accountId: 'default', room: '100' } : { accountId: 'default' }
      const result = await f.api.invoke(method, args)
      expect(result).toMatchObject({ ok: true, value: { accountId: 'default' } })
      const expected = method === 'getDouyuWatchTime' ? ['default', '100', calls.at(-1)!.signal] : ['default', calls.at(-1)!.signal]
      expect(f.gateway[gatewayMethod]).toHaveBeenCalledWith(...expected)
      expect(await f.api.invoke(method, { ...args, cookie: 'renderer-claim' })).toMatchObject({ code: 'invalid-arguments' })
    }
    expect(calls.map(call => call.id)).toEqual(['default', 'default', 'default', 'default'])
    f.dispose()
  })

  it('uses the injected lifetime for room refresh and IPC identity for playback', async () => {
    const f = insightsFixture()
    expect(await f.api.invoke('getDouyuRoomInsights', { room: '100' })).toMatchObject({ ok: true, value: { room: '100', viewers: null } })
    expect(await f.api.invoke('refreshDouyuRoomInsights', { room: '100' })).toMatchObject({ ok: true, value: { live: true } })
    expect(f.insights.refreshRoom).toHaveBeenCalledWith('100', f.lifetime.signal)
    expect(await f.api.invoke('reportDouyuPlayback', { room: '100', playing: true })).toMatchObject({ code: 'forbidden' })
    expect(await f.api.invoke('reportDouyuPlayback', { room: '100', playing: true, senderId: 1 }, { senderId: 2 })).toMatchObject({ code: 'invalid-arguments' })
    expect(await f.api.invoke('reportDouyuPlayback', { room: '100', playing: true }, { senderId: 2 })).toMatchObject({ ok: true })
    expect(f.insights.reportPlayback).toHaveBeenCalledExactlyOnceWith('100', true, 'window:2')
    f.dispose()
  })

  it('validates notification targets before changing monitor state', async () => {
    let accountChecks = 0
    const f = insightsFixture(async (_id, run) => { accountChecks++; return run(new AbortController().signal) })
    for (const args of [{ enabled: true, rooms: ['100', '100'] }, { enabled: true, rooms: Array(65).fill('100') },
      { enabled: true, rooms: ['100', '../200'] }, { enabled: true, rooms: Array(1) }, { enabled: true, accountId: 'unknown' }]) {
      expect(await f.api.invoke('setDouyuLiveNotifications', args)).toMatchObject({ code: 'invalid-arguments' })
    }
    expect(f.insights.setNotifications).not.toHaveBeenCalled()
    expect(await f.api.invoke('setDouyuLiveNotifications', { enabled: true, rooms: ['100'], accountId: 'default' }))
      .toEqual({ ok: true, value: { enabled: true, rooms: ['100'], followedAccountId: 'default' } })
    expect(f.insights.startFollowMonitor).toHaveBeenCalledExactlyOnceWith('default')
    expect(accountChecks).toBe(1)
    expect(await f.api.invoke('setDouyuLiveNotifications', { enabled: false }))
      .toEqual({ ok: true, value: { enabled: false, rooms: [], followedAccountId: null } })
    expect(f.insights.stopFollowMonitor).toHaveBeenCalledOnce()
    f.dispose()
  })

  it('exposes update status/checks but accepts no renderer update URLs or installation commands', async () => {
    const f = insightsFixture()
    for (const method of ['checkAppUpdate', 'getAppUpdateState']) {
      expect(await f.api.invoke(method, undefined)).toMatchObject({ ok: true, value: { phase: 'unconfigured' } })
      expect(await f.api.invoke(method, { url: 'https://untrusted.invalid/' })).toMatchObject({ code: 'invalid-arguments' })
    }
    expect(f.update.check).toHaveBeenCalledOnce()
    expect(f.update.state).toHaveBeenCalledOnce()
    expect(await f.api.invoke('installUpdate', undefined)).toMatchObject({ code: 'not-found' })
    f.dispose()
  })
})

describe('account generation guard', () => {
  it('rejects invalid, inactive, busy and logged-out accounts before running the operation', async () => {
    const f = accountsFixture(), run = vi.fn()
    const withAccount = createFeatureAccountGuard(f.accounts)
    await expect(withAccount('not-an-account', run)).rejects.toMatchObject({ code: 'invalid-arguments' })
    await expect(withAccount(OTHER_ACCOUNT, run)).rejects.toMatchObject({ code: 'account-changed' })
    f.state.busy = true
    await expect(withAccount('default', run)).rejects.toMatchObject({ code: 'account-busy' })
    f.state.busy = false
    f.activeLoginStatus.mockResolvedValueOnce(loginStatus(false))
    await expect(withAccount('default', run)).rejects.toMatchObject({ code: 'login-required' })
    expect(run).not.toHaveBeenCalled()
    expect(f.listeners.size).toBe(0)
  })

  it('cancels a delayed login check after switching away and back before it settles', async () => {
    const f = accountsFixture(), login = deferred<ReturnType<typeof loginStatus>>(), run = vi.fn()
    f.activeLoginStatus.mockReturnValueOnce(login.promise)
    const pending = createFeatureAccountGuard(f.accounts)('default', run)
    const observed = expect(pending).rejects.toMatchObject({ code: 'account-changed' })
    f.state.active = OTHER_ACCOUNT; f.emit({ type: 'changed' })
    f.state.active = 'default'; f.emit({ type: 'changed' })
    await observed
    expect(f.listeners.size).toBe(0)
    login.resolve(loginStatus())
    await Promise.resolve()
    expect(run).not.toHaveBeenCalled()
    expect(f.releases).toHaveBeenCalledOnce()
  })

  it.each(['changed', 'invalidated', 'switch-back', 'lifetime'])('aborts the operation promptly after %s even if the provider ignores the signal', async action => {
    const f = accountsFixture(), wait = deferred<string>(), started = deferred<void>(), lifetime = new AbortController()
    let signal: AbortSignal | undefined
    const pending = createFeatureAccountGuard(f.accounts, lifetime.signal)('default', input => {
      signal = input; started.resolve(); return wait.promise
    })
    const observed = expect(pending).rejects.toMatchObject({ code: action === 'lifetime' ? 'cancelled' : 'account-changed' })
    await started.promise
    if (action === 'changed') f.emit({ type: 'changed' })
    if (action === 'invalidated') f.emit({ type: 'invalidated', accountId: 'default' })
    if (action === 'switch-back') {
      f.state.active = OTHER_ACCOUNT; f.emit({ type: 'changed' })
      f.state.active = 'default'; f.emit({ type: 'changed' })
    }
    if (action === 'lifetime') lifetime.abort()
    expect(signal?.aborted).toBe(true)
    await observed
    expect(f.listeners.size).toBe(0)
    wait.reject(new Error('late provider rejection'))
    await Promise.resolve()
  })

  it('ignores another account invalidation and cleans listeners after success', async () => {
    const f = accountsFixture(), wait = deferred<string>(), started = deferred<void>()
    let signal: AbortSignal | undefined
    const pending = createFeatureAccountGuard(f.accounts)('default', input => { signal = input; started.resolve(); return wait.promise })
    await started.promise
    f.emit({ type: 'invalidated', accountId: OTHER_ACCOUNT })
    expect(signal?.aborted).toBe(false)
    wait.resolve('current account result')
    expect(await pending).toBe('current account result')
    expect(f.listeners.size).toBe(0)
    expect(f.releases).toHaveBeenCalledOnce()
  })

  it('never delivers a stale sensitive query through FeatureApi after account invalidation', async () => {
    const accounts = accountsFixture(), query = deferred<DouyuMonthlySpending>(), started = deferred<void>()
    const f = insightsFixture(createFeatureAccountGuard(accounts.accounts))
    let requestSignal: AbortSignal | undefined
    vi.mocked(f.gateway.readMonthlySpending).mockImplementationOnce((_id, signal) => { requestSignal = signal; started.resolve(); return query.promise })
    const pending = f.api.invoke('getDouyuMonthlySpending', { accountId: 'default' }, { senderId: 1 })
    await started.promise
    accounts.emit({ type: 'invalidated', accountId: 'default' })
    expect(await pending).toMatchObject({ ok: false, code: 'account-changed' })
    expect(await pending).not.toHaveProperty('value')
    expect(requestSignal?.aborted).toBe(true)
    query.resolve(f.spending)
    f.dispose()
  })
})
