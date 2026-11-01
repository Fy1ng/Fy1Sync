import type { HudPackValidation } from '../src/core/hudStylePack'
import type { StylePackCatalog, StylePackMirror, StylePackSource } from '../electron/stylePackSyncContracts'

export interface ReleaseValidators {
  parseHudStylePack(raw: unknown): HudPackValidation
  parseStylePackSource(raw: unknown): StylePackSource | null
  verifyStylePackCatalog(raw: unknown, source: StylePackSource): StylePackCatalog
}
export interface StylePackReleaseOptions {
  inputDirectory: string
  destination: string
  privateKeyPath: string
  mirrors: StylePackMirror[]
  revision: number
  previousManifest?: string
  minAppVersion?: string
  allowEmpty?: boolean
  workDir?: string
  validators?: ReleaseValidators
}
export function loadReleaseValidators(workDir?: string): Promise<ReleaseValidators>
export function generateStylePackKeys(directory: string): Promise<{ privatePath: string; publicPath: string; publicKey: string }>
export function prepareStylePackRelease(options: StylePackReleaseOptions): Promise<{
  catalog: StylePackCatalog
  source: StylePackSource
  destination: string
  manifestPath: string
  packs: number
}>
export const help: string
export function runStylePackRelease(argv: string[]): Promise<void>
