/** Signed data distribution is independent of application and recognizer code updates. */
export interface StylePackSource {
  manifestUrl: string
  /** Base64 DER SubjectPublicKeyInfo for one trusted Ed25519 publisher. */
  publicKey: string
}

export interface StylePackCatalogEntry {
  id: string
  revision: number
  sha256: string
  bytes: number
  /** Content-addressed path relative to the catalog's directory. */
  path: string
  minAppVersion: string
}

export interface StylePackCatalog {
  kind: 'fy1sync-stylepack-catalog'
  schemaVersion: 1
  revision: number
  packs: StylePackCatalogEntry[]
}

/** The signature covers the exact decoded payload bytes, without JSON reserialization. */
export interface SignedStylePackCatalog {
  payload: string
  signature: string
}

export interface StylePackSyncState {
  phase: 'unconfigured' | 'idle' | 'syncing' | 'current' | 'updated' | 'error'
  checkedAt: number | null
  updatedAt: number | null
  installed: number
  downloaded: number
  incompatible: number
  message: string
}

export type StylePackSyncEvent =
  | { topic: 'stylepacks-state'; data: StylePackSyncState }
  | { topic: 'stylepacks-changed'; data: { revision: number } }
