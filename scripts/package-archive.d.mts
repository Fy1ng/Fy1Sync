export interface ArchiveLimits {
  maxEntries: number
  maxArchiveBytes: number
  maxFileBytes: number
  maxTotalBytes: number
  maxCentralDirectoryBytes: number
}
export interface ArchiveOptions {
  limits?: Partial<ArchiveLimits>
  forbiddenPath?: (name: string) => boolean
}
export interface PackageSnapshot {
  files: Map<string, { size: number; sha256: string; crc32: number }>
  directories: Set<string>
  bytes: number
}
export function fingerprintRelease(directory: string, options?: ArchiveOptions): Promise<PackageSnapshot>
export function verifyPackageArchive(archive: string, expected: PackageSnapshot, options?: ArchiveOptions): Promise<{ files: number; directories: number; bytes: number }>
