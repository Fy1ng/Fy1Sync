import type { WebContents } from 'electron'
import type { LoginCardAction, LoginPageActionResult, LoginPageAdapter, LoginPageSnapshot } from './loginCardContracts'
import { parseLoginPageSnapshot } from './loginCardValidation'

type Frame = { id: string; url: string; loaderId?: string; parentId?: string; sessionId?: string }
type FrameTree = { frame: Frame; childFrames?: FrameTree[] }
interface FrameSnapshot { frame: Frame; snapshot: LoginPageSnapshot }
type FrameGeometry = { x: number; y: number; width: number; height: number; scaleX: number; scaleY: number }
type ChallengeTarget = { targetId: string; type: string; url: string; parentFrameId?: string }

/** Runs against the iframe owner in its parent's isolated world. Returns no page content. */
function inspectFrameOwner(this: HTMLIFrameElement): FrameGeometry | null {
  if (!(this instanceof HTMLIFrameElement) || !this.isConnected || this.ownerDocument !== document) return null
  for (let node: Element | null = this; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || style.display === 'none'
      || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return null
    if (style.transform && style.transform !== 'none') {
      const matrix = new DOMMatrixReadOnly(style.transform)
      if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) return null
    }
  }
  const rect = this.getBoundingClientRect(), style = getComputedStyle(this)
  const number = (value: string) => parseFloat(value) || 0
  const left = number(style.borderLeftWidth) + number(style.paddingLeft)
  const right = number(style.borderRightWidth) + number(style.paddingRight)
  const top = number(style.borderTopWidth) + number(style.paddingTop)
  const bottom = number(style.borderBottomWidth) + number(style.paddingBottom)
  const width = number(style.width) - (style.boxSizing === 'border-box' ? left + right : 0)
  const height = number(style.height) - (style.boxSizing === 'border-box' ? top + bottom : 0)
  const scaleX = rect.width / (width + left + right), scaleY = rect.height / (height + top + bottom)
  const geometry = { x: rect.x + left * scaleX, y: rect.y + top * scaleY, width, height, scaleX, scaleY }
  return width > 0 && height > 0 && scaleX > 0 && scaleY > 0 && Object.values(geometry).every(Number.isFinite) ? geometry : null
}

/** Fixed official selectors stay in an isolated world, separate from both preloads. */
export class LoginPageBroker {
  private last: FrameSnapshot | null = null
  private prepared = new Set<string>()
  private inspection: Promise<LoginPageSnapshot> | null = null
  private generation = 0
  private closed = false
  private entryPrepared = false
  private challengeSessions = new Map<string, string>()
  private presentationWork: Promise<boolean> = Promise.resolve(true)
  constructor(private readonly contents: WebContents, readonly adapter: LoginPageAdapter) {}

  reset(): void { this.generation++; this.last = null; this.prepared.clear() }
  restart(): void { this.entryPrepared = false; this.reset() }
  close(): void {
    this.closed = true
    this.reset()
    for (const sessionId of this.challengeSessions.values()) void this.detachChallenge(sessionId)
    this.challengeSessions.clear()
  }
  private async frames(): Promise<Frame[]> {
    const debug = this.contents.debugger
    if (!debug.isAttached()) debug.attach('1.3')
    const tree = await debug.sendCommand('Page.getFrameTree') as { frameTree: FrameTree }
    const result: Frame[] = []
    const walk = (node: FrameTree, parentId?: string) => {
      if (result.length < 32) result.push({ ...node.frame, parentId })
      for (const child of node.childFrames ?? []) if (result.length < 32) walk(child, node.frame.id)
    }
    walk(tree.frameTree)
    if (this.adapter.challengeInspectScript && this.adapter.acceptsChallengeFrame) await this.appendChallengeTargets(result)
    return result
  }

  /** OOPIFs are absent from the main target's frame tree. Attach only to its own challenge. */
  private async appendChallengeTargets(frames: Frame[]): Promise<void> {
    const debug = this.contents.debugger
    const generation = this.generation
    try {
      const targets = await debug.sendCommand('Target.getTargets', { filter: [{ type: 'iframe' }] }) as { targetInfos?: ChallengeTarget[] }
      if (!Array.isArray(targets.targetInfos)) return
      const active = new Set<string>()
      for (const target of targets.targetInfos.filter(item => item.type === 'iframe' && this.adapter.acceptsChallengeFrame?.(item.url)).slice(0, 8)) {
        if (this.closed || generation !== this.generation || frames.length >= 32) break
        if (frames.some(frame => frame.id === target.targetId)) continue
        // The renderer must own this exact remote iframe. A matching public URL is insufficient.
        try { await debug.sendCommand('DOM.getFrameOwner', { frameId: target.targetId }) } catch { continue }
        let sessionId = this.challengeSessions.get(target.targetId)
        try {
          if (!sessionId) {
            const attached = await debug.sendCommand('Target.attachToTarget', { targetId: target.targetId, flatten: true }) as { sessionId?: string }
            if (!attached.sessionId) continue
            sessionId = attached.sessionId
            if (this.closed || generation !== this.generation) { await this.detachChallenge(sessionId); break }
            this.challengeSessions.set(target.targetId, sessionId)
          }
          const child = await debug.sendCommand('Page.getFrameTree', {}, sessionId) as { frameTree?: FrameTree }
          const frame = child.frameTree?.frame
          const parentId = frame?.parentId ?? target.parentFrameId
          const parent = frames.find(item => item.id === parentId)
          if (!frame || frame.id !== target.targetId || !this.adapter.acceptsChallengeFrame?.(frame.url)
            || !parent || !this.adapter.acceptsFrame(parent.url)) continue
          frames.push({ ...frame, parentId, sessionId })
          active.add(target.targetId)
        } catch { /* A detached or navigating captcha is inspected on a later poll. */ }
      }
      for (const [id, sessionId] of this.challengeSessions) if (!active.has(id)) {
        this.challengeSessions.delete(id)
        await this.detachChallenge(sessionId)
      }
    } catch { /* Keep the platform's own card available if target discovery is unavailable. */ }
  }

  private async detachChallenge(sessionId: string): Promise<void> {
    if (this.contents.isDestroyed()) return
    await this.contents.debugger.sendCommand('Target.detachFromTarget', { sessionId }).catch(() => {})
  }

  private async evaluate(frame: Frame, code: string, userGesture = false): Promise<unknown> {
    if (this.closed || this.contents.isDestroyed()) return null
    const debug = this.contents.debugger
    const world = await debug.sendCommand('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'fy1sync-official-login' }, frame.sessionId) as { executionContextId: number }
    const result = await debug.sendCommand('Runtime.evaluate', { expression: code, contextId: world.executionContextId,
      returnByValue: true, awaitPromise: true, userGesture, timeout: 5000 }, frame.sessionId) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    // Never propagate exception text or remote objects that may echo submitted inputs.
    return result.exceptionDetails ? null : result.result?.value ?? null
  }

  inspect(): Promise<LoginPageSnapshot> {
    if (this.inspection) return this.inspection
    const work = this.inspectFrames()
    this.inspection = work
    void work.finally(() => { if (this.inspection === work) this.inspection = null }).catch(() => {})
    return work
  }

  /** Serialize paint changes so an explicit official-page request cannot race a stale crop. */
  presentChallenge(challengeOnly: boolean): Promise<boolean> {
    if (!this.adapter.presentationScript) return Promise.resolve(true)
    const generation = this.generation
    const script = this.adapter.presentationScript(challengeOnly)
    const work = this.presentationWork.catch(() => false).then(async () => {
      if (this.closed || generation !== this.generation || this.contents.isDestroyed()) return false
      try {
        const frames = (await this.frames()).filter(frame => !frame.sessionId && this.adapter.acceptsFrame(frame.url))
        if (!frames.length) return !challengeOnly
        for (const frame of frames) {
          if (this.closed || generation !== this.generation) return false
          const result = await this.evaluate(frame, script)
          if (!result || typeof result !== 'object' || (result as { ok?: boolean }).ok !== true) return false
        }
        return !this.closed && generation === this.generation
      } catch { return false }
    })
    this.presentationWork = work
    return work
  }
  private async inspectFrames(): Promise<LoginPageSnapshot> {
    if (this.closed || this.contents.isDestroyed()) return { page: 'unknown' }
    const generation = this.generation
    try {
      const frames = await this.frames()
      const snapshots: FrameSnapshot[] = []
      const challenges: FrameSnapshot[] = []
      for (const frame of frames) {
        const initialParent = frame.url === this.adapter.entryUrl && Boolean(this.adapter.prepareScript)
        if (this.adapter.challengeInspectScript && this.adapter.acceptsChallengeFrame?.(frame.url)
          && !this.adapter.acceptsFrame(frame.url)) {
          const geometry = await this.challengeFrameGeometry(frame, frames)
          if (!geometry) continue
          const inspected = parseLoginPageSnapshot(await this.evaluate(frame, this.adapter.challengeInspectScript))
          // A visible vendor document still initializing must not expose the stale parent card.
          const snapshot: LoginPageSnapshot = inspected?.challengePhase
            ? { page: inspected.page === 'challenge' ? 'challenge' : 'loading', challengePhase: inspected.challengePhase, qrStatus: 'paused' }
            : { page: 'loading', challengePhase: 'loading', qrStatus: 'paused' }
          if (snapshot.page === 'challenge' && inspected?.challenge) {
            snapshot.challenge = this.mapChallengeRegion(inspected.challenge, geometry)
            if (!snapshot.challenge) { snapshot.page = 'loading'; snapshot.challengePhase = 'unknown' }
          }
          challenges.push({ frame, snapshot })
          continue
        }
        if (!this.adapter.acceptsFrame(frame.url) && !initialParent) continue
        if (this.closed || generation !== this.generation) return { page: 'loading' }
        const key = `${frame.id}:${frame.loaderId}:${frame.url}`
        if (this.adapter.prepareScript && initialParent && !this.entryPrepared && !this.prepared.has(key)) {
          const prepared = await this.evaluate(frame, this.adapter.prepareScript)
          if (prepared && typeof prepared === 'object' && (prepared as { ok?: boolean }).ok === true) {
            this.prepared.add(key)
            this.entryPrepared = true
          }
        }
        if (!this.adapter.acceptsFrame(frame.url)) continue
        const snapshot = parseLoginPageSnapshot(await this.evaluate(frame, this.adapter.inspectScript))
        if (snapshot) snapshots.push({ frame, snapshot })
      }
      if (this.closed || generation !== this.generation) return { page: 'loading' }
      const selected = challenges[0] ?? snapshots.find(item => item.snapshot.page === 'challenge')
        ?? snapshots.find(item => item.snapshot.page === 'second-factor')
        ?? snapshots.find(item => item.snapshot.page === 'form')
        ?? snapshots.find(item => item.snapshot.page === 'unknown') ?? snapshots[0]
      const initializing = !selected && !this.last && frames.some(frame => frame.url === this.adapter.entryUrl)
        && !frames.some(frame => this.adapter.acceptsFrame(frame.url))
      this.last = selected ?? null
      if (selected?.snapshot.challenge && !challenges.includes(selected) && selected.frame.id !== frames[0]?.id) {
        selected.snapshot.challenge = await this.translateRegion(selected.frame, selected.snapshot.challenge)
      }
      return selected?.snapshot ?? { page: initializing ? 'loading' : 'unknown' }
    } catch { return { page: 'loading' } }
  }

  async act(action: LoginCardAction): Promise<LoginPageActionResult> {
    const last = this.last
    if (this.closed || !last || last.frame.sessionId || !this.adapter.acceptsFrame(last.frame.url)) return { ok: false, reason: 'not-ready' }
    const before = this.generation
    try {
      const frames = await this.frames()
      const current = frames.find(frame => frame.id === last.frame.id && frame.loaderId === last.frame.loaderId && frame.url === last.frame.url)
      if (!current || before !== this.generation) return { ok: false, reason: 'not-ready' }
      const raw = await this.evaluate(current, this.adapter.actionScript(action), true)
      if (this.closed || before !== this.generation) return { ok: false, reason: 'not-ready' }
      if (raw && typeof raw === 'object' && (raw as { ok?: boolean }).ok === true) return { ok: true }
      const reason = raw && typeof raw === 'object' ? (raw as { reason?: unknown }).reason : undefined
      return { ok: false, reason: reason === 'invalid-input' || reason === 'not-ready' ? reason : 'unsupported' }
    } catch { return { ok: false, reason: 'not-ready' } }
  }

  /** Only visible challenge owners under the platform's own documents can affect presentation. */
  private async challengeFrameGeometry(frame: Frame, frames: Frame[]): Promise<FrameGeometry[] | null> {
    const geometry: FrameGeometry[] = []
    let current = frame
    try {
      while (current.parentId) {
        const parent = frames.find(item => item.id === current.parentId)
        if (!parent || !this.adapter.acceptsFrame(parent.url)) return null
        const debug = this.contents.debugger
        const owner = await debug.sendCommand('DOM.getFrameOwner', { frameId: current.id }, parent.sessionId) as { backendNodeId?: number }
        if (!owner.backendNodeId) return null
        const world = await debug.sendCommand('Page.createIsolatedWorld', { frameId: parent.id, worldName: 'fy1sync-official-login' }, parent.sessionId) as { executionContextId: number }
        const resolved = await debug.sendCommand('DOM.resolveNode', { backendNodeId: owner.backendNodeId, executionContextId: world.executionContextId }, parent.sessionId) as { object?: { objectId?: string } }
        const objectId = resolved.object?.objectId
        if (!objectId) return null
        try {
          const result = await debug.sendCommand('Runtime.callFunctionOn', { objectId, functionDeclaration: inspectFrameOwner.toString(), returnByValue: true, silent: true }, parent.sessionId) as { result?: { value?: FrameGeometry }; exceptionDetails?: unknown }
          const value = result.exceptionDetails ? null : result.result?.value
          if (!value || !['x', 'y', 'width', 'height', 'scaleX', 'scaleY'].every(key => typeof value[key as keyof FrameGeometry] === 'number'
            && Number.isFinite(value[key as keyof FrameGeometry])) || value.width <= 0 || value.height <= 0 || value.scaleX <= 0 || value.scaleY <= 0) return null
          geometry.push(value)
        } finally { await debug.sendCommand('Runtime.releaseObject', { objectId }, parent.sessionId).catch(() => {}) }
        current = parent
      }
      return geometry.length && current.id === frames[0]?.id ? geometry : null
    } catch { return null }
  }

  private mapChallengeRegion(region: NonNullable<LoginPageSnapshot['challenge']>, owners: FrameGeometry[]): LoginPageSnapshot['challenge'] {
    let mapped = { ...region }
    for (const owner of owners) {
      if (mapped.x < -1 || mapped.y < -1 || mapped.x + mapped.width > owner.width + 1 || mapped.y + mapped.height > owner.height + 1) return undefined
      mapped = { x: owner.x + mapped.x * owner.scaleX, y: owner.y + mapped.y * owner.scaleY,
        width: mapped.width * owner.scaleX, height: mapped.height * owner.scaleY }
    }
    return parseLoginPageSnapshot({ page: 'challenge', challenge: mapped })?.challenge
  }

  /** CDP gives the iframe's top-document content quad, preserving the original challenge DOM. */
  private async translateRegion(frame: Frame, region: NonNullable<LoginPageSnapshot['challenge']>): Promise<LoginPageSnapshot['challenge']> {
    try {
      const debug = this.contents.debugger
      const owner = await debug.sendCommand('DOM.getFrameOwner', { frameId: frame.id }) as { backendNodeId?: number }
      if (!owner.backendNodeId) return undefined
      const model = await debug.sendCommand('DOM.getBoxModel', { backendNodeId: owner.backendNodeId }) as { model?: { content?: number[] } }
      const quad = model.model?.content
      if (!quad || quad.length !== 8 || quad.some(value => !Number.isFinite(value))) return undefined
      return { ...region, x: region.x + Math.min(quad[0]!, quad[2]!, quad[4]!, quad[6]!), y: region.y + Math.min(quad[1]!, quad[3]!, quad[5]!, quad[7]!) }
    } catch { return undefined }
  }
}
