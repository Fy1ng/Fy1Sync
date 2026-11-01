/** Executable updates have a separate signing key from data-only style packs. */
export type OnlineUpdateSourceId = 'github' | 'gitcode'
export type OnlineUpdateKind = 'frontend' | 'application'
export interface OnlineUpdateSource {
  mirrors: Array<{ id: OnlineUpdateSourceId; manifestUrl: string }>
  publicKey: string
}

export interface SignedUpdateCatalog { payload: string; signature: string }
export interface FrontendUpdateEntry {
  revision: number
  version: string
  minAppVersion: string
  maxAppVersion: string
  bridgeVersion: number
  sha256: string
  bytes: number
  path: string
  notes: string
}
export interface ApplicationUpdateDownload {
  url: string
  /** Exact HTTPS origins the signed publisher permits for download redirects. */
  redirectOrigins: string[]
}
export interface ApplicationUpdateEntry {
  version: string
  platform: 'win32'
  arch: 'x64'
  sha256: string
  bytes: number
  notes: string
  downloads: Partial<Record<OnlineUpdateSourceId, ApplicationUpdateDownload>>
}
export interface OnlineUpdateCatalog {
  kind: 'fy1sync-update-catalog'
  schemaVersion: 1
  revision: number
  frontend: FrontendUpdateEntry | null
  application: ApplicationUpdateEntry | null
}

/** An uncompressed, bounded asset container, not an arbitrary filesystem archive. */
export interface FrontendBundle {
  kind: 'fy1sync-frontend-bundle'
  schemaVersion: 1
  revision: number
  version: string
  bridgeVersion: number
  files: Array<{ path: string; content: string }>
}

export interface OnlineUpdateItemState {
  phase: 'unavailable' | 'current' | 'available' | 'incompatible' | 'downloading' | 'ready' | 'trial' | 'rolled-back' | 'error'
  version: string | null
  revision: number | null
  notes: string | null
  downloadedBytes: number
  totalBytes: number | null
  message: string
}
export interface OnlineUpdateState {
  phase: 'unconfigured' | 'idle' | 'checking' | 'error'
  source: OnlineUpdateSourceId
  availableSources: OnlineUpdateSourceId[]
  currentAppVersion: string
  currentFrontendRevision: number
  bridgeVersion: number
  checkedAt: number | null
  frontend: OnlineUpdateItemState
  application: OnlineUpdateItemState
  canRollbackFrontend: boolean
  message: string
}

export interface FrontendSnapshot {
  currentRevision: number
  currentVersion: string
  phase: 'bundled' | 'current' | 'trial' | 'rolled-back'
  staged: FrontendUpdateEntry | null
  canRollback: boolean
  /** Failed or explicitly rolled-back revisions cannot be offered again. */
  blockedRevision: number
  message: string
}
export interface FrontendUpdatePort {
  snapshot(): FrontendSnapshot
  stage(entry: FrontendUpdateEntry, envelope: SignedUpdateCatalog, bytes: Uint8Array): Promise<void>
  discardStaged(): Promise<void>
}

export const UPDATE_LIMITS = {
  catalogBytes: 256 * 1024,
  frontendBytes: 48 * 1024 * 1024,
  frontendFileBytes: 16 * 1024 * 1024,
  frontendDecodedBytes: 32 * 1024 * 1024,
  frontendFiles: 512,
  installerBytes: 1024 * 1024 * 1024,
} as const
