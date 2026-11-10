import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { LoginPageBroker } from './loginPageBroker'
import type { LoginPageAdapter, LoginPageSnapshot } from './loginCardContracts'

type Tree = { frame: { id: string; loaderId: string; url: string; parentId?: string }; childFrames?: Tree[] }
function setup(prepare = false) {
  let tree: Tree = { frame: { id: 'frame-1', loaderId: 'load-1', url: 'https://passport.fixture.test/login' } }
  const snapshots = new Map<string, LoginPageSnapshot>([['frame-1', { page: 'form', mode: 'password', qrStatus: 'unavailable' }]])
  const contexts = new Map<number, string>()
  const owners = new Map<string, { x: number; y: number; width: number; height: number; scaleX: number; scaleY: number } | null>()
  const ownerIds = new Map<number, string>()
  const targets = new Map<string, Tree>()
  let nextContext = 10
  let reply: ((expression: string, frameId: string) => Promise<unknown>) | undefined
  const adapter: LoginPageAdapter = { entryUrl: prepare ? 'https://parent.fixture.test/' : tree.frame.url,
    acceptsFrame: url => url.startsWith('https://passport.fixture.test/'), inspectScript: 'INSPECT_FIXED_DOM', actionScript: () => 'ONE_FIXED_ACTION',
    ...(prepare ? { prepareScript: 'PREPARE_OFFICIAL_COMPONENT' } : {}) }
  const contents = { isDestroyed: vi.fn(() => false), debugger: { isAttached: vi.fn(() => false), attach: vi.fn(),
    sendCommand: vi.fn(async (method: string, args?: Record<string, unknown>, sessionId?: string): Promise<unknown> => {
      if (method === 'Page.getFrameTree') return { frameTree: structuredClone(sessionId ? targets.get(sessionId.replace('session-', '')) : tree) }
      if (method === 'Target.getTargets') return { targetInfos: [...targets.values()].map(item => ({ targetId: item.frame.id, type: 'iframe', url: item.frame.url })) }
      if (method === 'Target.attachToTarget') return { sessionId: `session-${String(args?.targetId)}` }
      if (method === 'Target.detachFromTarget') return {}
      if (method === 'Page.createIsolatedWorld') { const id = nextContext++; contexts.set(id, String(args?.frameId)); return { executionContextId: id } }
      if (method === 'DOM.getFrameOwner') {
        if (!owners.has(String(args?.frameId))) throw new Error('Frame does not belong to this target')
        const id = nextContext++; ownerIds.set(id, String(args?.frameId)); return { backendNodeId: id }
      }
      if (method === 'DOM.resolveNode') return { object: { objectId: ownerIds.get(Number(args?.backendNodeId)) } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: owners.get(String(args?.objectId)) ?? null } }
      if (method === 'Runtime.releaseObject') return {}
      const expression = String(args?.expression)
      const frameId = contexts.get(Number(args?.contextId)) ?? ''
      if (reply) return await reply(expression, frameId)
      return { result: { value: expression === adapter.inspectScript || expression === adapter.challengeInspectScript ? snapshots.get(frameId) : { ok: true } } }
    }),
  } }
  const broker = new LoginPageBroker(contents as unknown as WebContents, adapter)
  return { broker, adapter, contents, snapshots, owners, targets, setTree: (value: Tree) => { tree = value },
    setReply: (value: (expression: string, frameId: string) => Promise<unknown>) => { reply = value },
    actionCount: () => contents.debugger.sendCommand.mock.calls.filter(([method, args]) => method === 'Runtime.evaluate' && args?.expression === adapter.actionScript({ kind: 'cancel' })).length }
}

describe('isolated official login-page broker', () => {
  it('creates an isolated world and evaluates fixed DOM code only in that frame context', async () => {
    const f = setup()
    expect(await f.broker.inspect()).toMatchObject({ page: 'form', mode: 'password' })
    expect(f.contents.debugger.attach).toHaveBeenCalledWith('1.3')
    expect(f.contents.debugger.sendCommand).toHaveBeenCalledWith('Page.createIsolatedWorld', { frameId: 'frame-1', worldName: 'fy1sync-official-login' }, undefined)
    expect(f.contents.debugger.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({ expression: 'INSPECT_FIXED_DOM', contextId: 10, returnByValue: true, awaitPromise: true }), undefined)
    expect(await f.broker.act({ kind: 'mode', mode: 'sms' })).toEqual({ ok: true })
    expect(f.actionCount()).toBe(1)
    expect(f.contents.debugger.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({ expression: 'ONE_FIXED_ACTION', contextId: 11 }), undefined)
    f.broker.close()
  })

  it('shares overlapping inspections instead of polling or evaluating the same DOM twice', async () => {
    const f = setup()
    const first = f.broker.inspect()
    expect(f.broker.inspect()).toBe(first)
    await first
    expect(f.contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Page.getFrameTree')).toHaveLength(1)
    f.broker.close()
  })

  it('selects a challenge before second-factor or basic forms in separate accepted frames', async () => {
    const f = setup()
    f.setTree({ frame: { id: 'frame-1', loaderId: 'load-1', url: 'https://passport.fixture.test/login' }, childFrames: [
      { frame: { id: 'factor', loaderId: 'load-2', url: 'https://passport.fixture.test/second' } },
      { frame: { id: 'captcha', loaderId: 'load-3', url: 'https://passport.fixture.test/challenge' } },
    ] })
    f.snapshots.set('factor', { page: 'second-factor', verification: { kind: 'sms', maskedTarget: '138****0000' } })
    f.snapshots.set('captcha', { page: 'challenge', qrStatus: 'paused' })
    expect(await f.broker.inspect()).toEqual({ page: 'challenge', qrStatus: 'paused' })
    f.broker.close()
  })

  function vendorSetup(nested = false) {
    const f = setup()
    f.adapter.acceptsChallengeFrame = url => url === 'https://challenge.fixture.test/captcha'
    f.adapter.challengeInspectScript = 'READ_ONLY_VENDOR_CHALLENGE'
    const child: Tree = { frame: { id: 'captcha', loaderId: 'captcha-load', url: 'https://challenge.fixture.test/captcha' } }
    const account: Tree = { frame: { id: 'account', loaderId: 'account-load', url: 'https://passport.fixture.test/iframe' }, childFrames: [child] }
    const tree: Tree = { frame: { id: 'frame-1', loaderId: 'load-1', url: 'https://passport.fixture.test/login' }, childFrames: [nested ? account : child] }
    f.setTree(tree)
    f.owners.set('captcha', { x: 69.6666718, y: 95.6666718, width: 360, height: 360, scaleX: 1, scaleY: 1 })
    f.owners.set('account', { x: 250, y: 120, width: 500, height: 550, scaleX: 1, scaleY: 1 })
    f.snapshots.set('captcha', { page: 'challenge', challengePhase: 'interactive', challenge: { x: 0, y: 0, width: 360, height: 360 } })
    return { ...f, tree }
  }

  it.each([false, true])('reads a vendor challenge and maps the entire card through its owners (nested=%s)', async nested => {
    const f = vendorSetup(nested)
    expect(await f.broker.inspect()).toEqual({ page: 'challenge', challengePhase: 'interactive', qrStatus: 'paused',
      challenge: { x: 69.6666718 + (nested ? 250 : 0), y: 95.6666718 + (nested ? 120 : 0), width: 360, height: 360 } })
    expect(f.contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Runtime.releaseObject')).toHaveLength(nested ? 2 : 1)
    expect(await f.broker.act({ kind: 'password', username: 'fixture', password: 'private', accepted: true })).toEqual({ ok: false, reason: 'not-ready' })
    expect(f.actionCount()).toBe(0)
    f.broker.close()
  })

  it.each(['loading', 'verifying', 'passed', 'unknown'] as const)('uses the visible vendor %s phase instead of the stale parent challenge', async challengePhase => {
    const f = vendorSetup()
    f.snapshots.set('frame-1', { page: 'challenge', challengePhase: 'interactive', challenge: { x: 69, y: 95, width: 362, height: 362 } })
    f.snapshots.set('captcha', { page: 'loading', challengePhase, verificationCompleted: true, mode: 'password', sms: { canSend: true, cooldownSeconds: 0 } })
    expect(await f.broker.inspect()).toEqual({ page: 'loading', challengePhase, qrStatus: 'paused' })
    f.broker.close()
  })

  it('retains the local form when the vendor owner is hidden and resumes account actions after closing it', async () => {
    const f = vendorSetup()
    f.owners.set('captcha', null)
    expect(await f.broker.inspect()).toMatchObject({ page: 'form' })
    expect(f.contents.debugger.sendCommand.mock.calls.filter(([method, args]) => method === 'Runtime.evaluate' && args?.expression === f.adapter.challengeInspectScript)).toHaveLength(0)
    f.owners.set('captcha', { x: 70, y: 96, width: 360, height: 360, scaleX: 1, scaleY: 1 })
    expect(await f.broker.inspect()).toMatchObject({ page: 'challenge' })
    f.setTree({ frame: f.tree.frame })
    expect(await f.broker.inspect()).toMatchObject({ page: 'form' })
    expect(await f.broker.act({ kind: 'mode', mode: 'sms' })).toEqual({ ok: true })
    expect(f.actionCount()).toBe(1)
    f.broker.close()
  })

  it('never inspects a trusted vendor embedded beneath an unrelated account page', async () => {
    const f = vendorSetup(true)
    f.tree.childFrames![0]!.frame.url = 'https://unrelated.fixture.test/page'
    f.setTree(f.tree)
    expect(await f.broker.inspect()).toMatchObject({ page: 'form' })
    expect(f.contents.debugger.sendCommand.mock.calls.filter(([method, args]) => method === 'Runtime.evaluate' && args?.expression === f.adapter.challengeInspectScript)).toHaveLength(0)
    f.broker.close()
  })

  it('maps borders and scaled iframe content without assuming top-document CDP quads', async () => {
    const f = vendorSetup(true)
    f.owners.set('account', { x: 251, y: 121, width: 500, height: 550, scaleX: 0.8, scaleY: 0.8 })
    f.owners.set('captcha', { x: 70, y: 96, width: 360, height: 360, scaleX: 1, scaleY: 1 })
    expect(await f.broker.inspect()).toMatchObject({ challenge: { x: 307, y: 197.8, width: 288, height: 288 } })
    f.broker.close()
  })

  it('does not crop a provider card clipped by an intermediate login iframe', async () => {
    const f = vendorSetup(true)
    f.owners.set('account', { x: 250, y: 120, width: 300, height: 200, scaleX: 1, scaleY: 1 })
    expect(await f.broker.inspect()).toEqual({ page: 'loading', challengePhase: 'unknown', qrStatus: 'paused' })
    f.broker.close()
  })

  it('discovers an owned OOPIF absent from the main frame tree and evaluates only in its isolated target session', async () => {
    const f = vendorSetup(true)
    const account = f.tree.childFrames![0]!
    const captcha = account.childFrames![0]!
    captcha.frame.parentId = account.frame.id
    f.targets.set('captcha', captcha)
    account.childFrames = []
    f.setTree(f.tree)
    const snapshot = await f.broker.inspect()
    expect(snapshot).toMatchObject({ page: 'challenge', challengePhase: 'interactive', challenge: { width: 360, height: 360 } })
    expect(snapshot.challenge?.x).toBeCloseTo(319.6666718, 6)
    expect(snapshot.challenge?.y).toBeCloseTo(215.6666718, 6)
    expect(f.contents.debugger.sendCommand).toHaveBeenCalledWith('Target.attachToTarget', { targetId: 'captcha', flatten: true })
    expect(f.contents.debugger.sendCommand).toHaveBeenCalledWith('Page.createIsolatedWorld', { frameId: 'captcha', worldName: 'fy1sync-official-login' }, 'session-captcha')
    expect(f.contents.debugger.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({ expression: f.adapter.challengeInspectScript, userGesture: false }), 'session-captcha')
    expect(await f.broker.act({ kind: 'send-sms', phone: '15500000000', countryCode: '+86', accepted: true })).toEqual({ ok: false, reason: 'not-ready' })
    f.snapshots.set('captcha', { page: 'loading', challengePhase: 'loading' })
    expect(await f.broker.inspect()).toEqual({ page: 'loading', challengePhase: 'loading', qrStatus: 'paused' })
    expect(f.contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Target.attachToTarget')).toHaveLength(1)
    expect(f.actionCount()).toBe(0)
    f.broker.close()
    expect(f.contents.debugger.sendCommand).toHaveBeenCalledWith('Target.detachFromTarget', { sessionId: 'session-captcha' })
  })

  it('does not attach to a matching captcha target belonging to another window', async () => {
    const f = vendorSetup()
    f.setTree({ frame: f.tree.frame })
    f.targets.set('foreign', { frame: { id: 'foreign', loaderId: 'foreign-load', parentId: 'frame-1', url: 'https://challenge.fixture.test/captcha' } })
    expect(await f.broker.inspect()).toMatchObject({ page: 'form' })
    expect(f.contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Target.attachToTarget')).toHaveLength(0)
    f.broker.close()
  })

  it('detaches a challenge session when its original iframe is removed', async () => {
    const f = vendorSetup()
    const captcha = f.tree.childFrames![0]!
    captcha.frame.parentId = f.tree.frame.id
    f.targets.set('captcha', captcha)
    f.setTree({ frame: f.tree.frame })
    expect(await f.broker.inspect()).toMatchObject({ page: 'challenge' })
    f.targets.clear()
    expect(await f.broker.inspect()).toMatchObject({ page: 'form' })
    expect(f.contents.debugger.sendCommand).toHaveBeenCalledWith('Target.detachFromTarget', { sessionId: 'session-captcha' })
    expect(await f.broker.act({ kind: 'mode', mode: 'sms' })).toEqual({ ok: true })
    f.broker.close()
  })

  it('ignores remote exceptions and objects that could echo sensitive fields', async () => {
    const f = setup()
    f.setReply(async () => ({ result: { value: { page: 'form', password: 'fixture-private' } }, exceptionDetails: { text: 'password=fixture-private' } }))
    expect(await f.broker.inspect()).toEqual({ page: 'unknown' })
    expect(await f.broker.act({ kind: 'mode', mode: 'sms' })).toEqual({ ok: false, reason: 'not-ready' })
    f.broker.close()
  })

  it('prepares an official parent once per loader and never inspects its unrelated document', async () => {
    const f = setup(true)
    const tree: Tree = { frame: { id: 'parent', loaderId: 'load-parent', url: f.adapter.entryUrl }, childFrames: [
      { frame: { id: 'frame-1', loaderId: 'load-1', url: 'https://passport.fixture.test/login' } },
    ] }
    f.setTree(tree)
    await f.broker.inspect()
    await f.broker.inspect()
    const prepareCalls = f.contents.debugger.sendCommand.mock.calls.filter(([method, args]) => method === 'Runtime.evaluate' && args?.expression === f.adapter.prepareScript)
    expect(prepareCalls).toHaveLength(1)
    // Prepare only the initial parent, never reopen login from a child or later navigation.
    expect(f.contents.debugger.sendCommand.mock.calls.filter(([method, args]) => method === 'Runtime.evaluate' && args?.expression === f.adapter.inspectScript)).toHaveLength(2)
    f.broker.close()
  })

  it('waits for the official parent to create its login frame before classifying a challenge', async () => {
    const f = setup(true)
    f.setTree({ frame: { id: 'parent', loaderId: 'load-parent', url: f.adapter.entryUrl } })
    expect(await f.broker.inspect()).toEqual({ page: 'loading' })
    f.setTree({ frame: { id: 'parent', loaderId: 'load-parent', url: f.adapter.entryUrl }, childFrames: [
      { frame: { id: 'frame-1', loaderId: 'load-1', url: 'https://passport.fixture.test/login' } },
    ] })
    expect(await f.broker.inspect()).toMatchObject({ page: 'form' })
    f.broker.close()
  })

  it('does not execute on an accepted frame whose loader changed after inspection', async () => {
    const f = setup()
    await f.broker.inspect()
    f.setTree({ frame: { id: 'frame-1', loaderId: 'load-new', url: 'https://passport.fixture.test/login' } })
    expect(await f.broker.act({ kind: 'mode', mode: 'sms' })).toEqual({ ok: false, reason: 'not-ready' })
    expect(f.actionCount()).toBe(0)
    f.broker.close()
  })

  it('invalidates a pending inspection when navigation resets its generation', async () => {
    const f = setup()
    let finish!: (value: unknown) => void
    f.setReply(() => new Promise(resolve => { finish = resolve }))
    const pending = f.broker.inspect()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    f.broker.reset()
    finish({ result: { value: { page: 'form', mode: 'password' } } })
    expect(await pending).toEqual({ page: 'loading' })
    expect(await f.broker.act({ kind: 'mode', mode: 'sms' })).toEqual({ ok: false, reason: 'not-ready' })
    f.broker.close()
  })

  it.each(['reset', 'close'] as const)('ignores late action success after %s invalidates its frame', async invalidate => {
    const f = setup()
    await f.broker.inspect()
    let finish!: (value: unknown) => void
    f.setReply(() => new Promise(resolve => { finish = resolve }))
    const pending = f.broker.act({ kind: 'mode', mode: 'sms' })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    f.broker[invalidate]()
    finish({ result: { value: { ok: true } } })
    expect(await pending).toEqual({ ok: false, reason: 'not-ready' })
    expect(f.actionCount()).toBe(1)
    f.broker.close()
  })

  it('never evaluates after the official contents is destroyed', async () => {
    const f = setup()
    f.contents.isDestroyed.mockReturnValue(true)
    expect(await f.broker.inspect()).toEqual({ page: 'unknown' })
    expect(f.contents.debugger.sendCommand).not.toHaveBeenCalled()
    f.broker.close()
  })
})
