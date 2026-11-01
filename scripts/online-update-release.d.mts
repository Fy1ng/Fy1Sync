import type { FrontendBundle, FrontendUpdateEntry, OnlineUpdateCatalog, OnlineUpdateSource } from '../electron/onlineUpdateContracts'

export interface OnlineUpdateReleaseValidators {
  parseOnlineUpdateSource(raw: unknown): OnlineUpdateSource | null
  verifyOnlineUpdateCatalog(raw: unknown, source: OnlineUpdateSource): OnlineUpdateCatalog
  validateFrontendBundle(raw: unknown, entry: FrontendUpdateEntry): FrontendBundle
  compareAppVersions(left: string, right: string): -1 | 0 | 1
}
export interface OnlineUpdateReleaseOptions {
  destination: string
  privateKeyPath: string
  sourcePath: string
  catalogRevision: number
  clientDirectory?: string
  revision?: number
  frontendVersion?: string
  minAppVersion?: string
  maxAppVersion?: string
  notesPath?: string
  applicationDescriptorPath?: string
  installerPath?: string
  /** Inherit both this signed manifest and its directory's immutable signed history. */
  previousManifest?: string
  dropFrontend?: boolean
  dropApplication?: boolean
  workDir?: string
  validators?: OnlineUpdateReleaseValidators
}
export function loadOnlineUpdateValidators(workDir?: string): Promise<OnlineUpdateReleaseValidators>
export function generateOnlineUpdateKeys(directory: string): Promise<{ privatePath: string; publicPath: string; publicKey: string }>
export function prepareOnlineUpdateRelease(options: OnlineUpdateReleaseOptions): Promise<{
  catalog: OnlineUpdateCatalog
  source: OnlineUpdateSource
  destination: string
  manifestPath: string
}>
export const help: string
export function runOnlineUpdateRelease(argv: string[]): Promise<void>
