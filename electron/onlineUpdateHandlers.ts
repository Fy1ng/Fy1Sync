import { FeatureApiError, type FeatureHandlers } from '../server/featureApi'
import type { FeatureCallContext } from './featureContracts'
import type { OnlineUpdateKind } from './onlineUpdateContracts'
import type { OnlineUpdateService } from './onlineUpdateService'

interface Options {
  service: Pick<OnlineUpdateService, 'state' | 'setSource' | 'check' | 'download' | 'cancel'>
  isPrimary: (senderId: number | undefined) => boolean
  apply: (kind: OnlineUpdateKind) => Promise<boolean>
  rollback: () => Promise<boolean>
  healthy: (bridgeVersion: number) => boolean
}
const invalid = (): never => { throw new FeatureApiError('invalid-arguments') }
function noArgs(value: unknown): void { if (value !== undefined) invalid() }
function field(raw: unknown, key: string): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Reflect.ownKeys(raw).length !== 1) return invalid()
  const descriptor = Object.getOwnPropertyDescriptor(raw, key)
  return descriptor && 'value' in descriptor ? descriptor.value : invalid()
}
function kind(raw: unknown): OnlineUpdateKind {
  const value = field(raw, 'kind')
  return value === 'frontend' || value === 'application' ? value : invalid()
}

/** Downloads and native lifecycle changes are available only to the primary app frame. */
export function createOnlineUpdateHandlers(options: Options): FeatureHandlers {
  let transitioning = false
  const primary = (context: FeatureCallContext) => {
    if (!options.isPrimary(context.senderId)) throw new FeatureApiError('forbidden')
  }
  const mutable = (context: FeatureCallContext) => {
    primary(context)
    if (transitioning) throw new FeatureApiError('busy')
  }
  const transition = async (run: () => Promise<boolean>): Promise<{ accepted: boolean }> => {
    transitioning = true
    try {
      const accepted = await run()
      if (!accepted) transitioning = false
      return { accepted }
    } catch (error) { transitioning = false; throw error }
  }
  const quiescent = () => {
    const state = options.service.state()
    if (state.phase === 'checking' || state.frontend.phase === 'downloading' || state.application.phase === 'downloading') throw new FeatureApiError('busy')
    return state
  }
  return {
    getOnlineUpdateState: (args, context) => { primary(context); noArgs(args); return options.service.state() },
    setOnlineUpdateSource: (args, context) => {
      mutable(context)
      const id = field(args, 'source')
      if (id !== 'github' && id !== 'gitcode') return invalid()
      return options.service.setSource(id)
    },
    checkOnlineUpdate: (args, context) => { mutable(context); noArgs(args); return options.service.check() },
    downloadOnlineUpdate: (args, context) => { mutable(context); return options.service.download(kind(args)) },
    cancelOnlineUpdate: (args, context) => { mutable(context); noArgs(args); return options.service.cancel() },
    applyOnlineUpdate: (args, context) => {
      mutable(context)
      const target = kind(args)
      if (quiescent()[target].phase !== 'ready') throw new FeatureApiError('not-available')
      return transition(() => options.apply(target))
    },
    rollbackFrontendUpdate: (args, context) => {
      mutable(context); noArgs(args)
      if (!quiescent().canRollbackFrontend) throw new FeatureApiError('not-available')
      return transition(options.rollback)
    },
    reportFrontendReady: (args, context) => {
      primary(context)
      const bridgeVersion = field(args, 'bridgeVersion')
      if (typeof bridgeVersion !== 'number' || !Number.isSafeInteger(bridgeVersion) || bridgeVersion < 1) return invalid()
      return { accepted: options.healthy(bridgeVersion) }
    },
  }
}
