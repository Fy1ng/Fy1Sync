import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

export interface PrivatePermissionTarget { target: string; directory: boolean; recursive?: boolean }

export interface PrivatePermissions {
  protect(target: string, directory: boolean, recursive?: boolean): void
  verify(target: string, directory: boolean, recursive?: boolean): void
  verifyManyAsync?(targets: readonly PrivatePermissionTarget[]): Promise<void>
  invalidate?(target: string, recursive?: boolean): void
}

const permissionFailure = () => new Error('无法验证账号数据的私有文件权限.')

export function powershellEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => name.toLowerCase() !== 'psmodulepath'))
}

/** Only Allow rules widen access; Chromium's own AppContainer capabilities are permitted. */
export const PRIVATE_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($env:STREAM_SYNC_PRIVATE_TARGETS) {
  $targets = @($env:STREAM_SYNC_PRIVATE_TARGETS | ConvertFrom-Json)
} else {
  $targets = @(@{ target = $env:STREAM_SYNC_PRIVATE_PATH; recursive = ($env:STREAM_SYNC_PRIVATE_RECURSIVE -eq '1') })
}
foreach ($target in $targets) {
  $items = @(Get-Item -Force -LiteralPath $target.target)
  if ($target.recursive) { $items += @(Get-ChildItem -Force -Recurse -LiteralPath $target.target) }
  foreach ($item in $items) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 1 }
    $rules = @($item.GetAccessControl().GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    $allows = @($rules | Where-Object { $_.AccessControlType -eq 'Allow' })
    if (@($allows | Where-Object { $_.IdentityReference.Value -ne $sid -and -not $_.IdentityReference.Value.StartsWith('S-1-15-3-') }).Count -ne 0) { exit 1 }
    if (@($allows | Where-Object { $_.IdentityReference.Value -eq $sid -and ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl }).Count -eq 0) { exit 1 }
  }
  if (-not (Get-Item -Force -LiteralPath $target.target).GetAccessControl().AreAccessRulesProtected) { exit 1 }
}
Write-Output 'PRIVATE_OK'
`

let activeChecks = 0
const waitingChecks: Array<() => void> = []

/** Multiple account snapshots must not launch an unbounded number of PowerShell hosts. */
async function permissionCheckSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeChecks < 4) activeChecks++
  else await new Promise<void>(resolve => waitingChecks.push(resolve))
  try { return await operation() } finally {
    const next = waitingChecks.shift()
    if (next) next()
    else activeChecks--
  }
}

function powershellExecutable(): string {
  return process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
}

function permissionEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(powershellEnvironment()).filter(([name]) => !name.toLowerCase().startsWith('stream_sync_private_')))
  return { ...inherited, ...environment }
}

export class NativePrivatePermissions implements PrivatePermissions {
  private sid: string | undefined
  private readonly verified = new Map<string, { fingerprint: string; checkedAt: number }>()
  private readonly checking = new Set<{ paths: Set<string>; invalidated: boolean }>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Only read checks use this cache; write-side verify/protect remain unconditional. */
  invalidate(target: string, recursive = false): void {
    const selected = path.resolve(target)
    const matches = (candidate: string) => candidate === selected || (recursive && candidate.startsWith(`${selected}${path.sep}`))
    for (const candidate of this.verified.keys()) if (matches(candidate)) this.verified.delete(candidate)
    for (const pending of this.checking) if ([...pending.paths].some(matches)) pending.invalidated = true
  }

  private fingerprint(target: PrivatePermissionTarget): string {
    assertRegularPath(target.target, target.directory)
    const stat = fs.lstatSync(target.target)
    return JSON.stringify([stat.mtimeMs, stat.size, stat.ino, stat.dev, target.directory])
  }

  private powershell(script: string, environment: NodeJS.ProcessEnv = {}): string {
    const result = spawnSync(powershellExecutable(), ['-NoProfile', '-NonInteractive', '-Command', script], {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 30_000,
      env: permissionEnvironment(environment), stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.error || result.status !== 0) throw permissionFailure()
    return result.stdout.trim()
  }

  private async powershellAsync(script: string, environment: NodeJS.ProcessEnv): Promise<string> {
    return permissionCheckSlot(() => new Promise<string>((resolve, reject) => {
      const child = spawn(powershellExecutable(), ['-NoProfile', '-NonInteractive', '-Command', script], {
        shell: false, windowsHide: true, env: permissionEnvironment(environment), stdio: ['ignore', 'pipe', 'ignore'],
      })
      let output = '', settled = false
      const finish = (success: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (success) resolve(output.trim())
        else reject(permissionFailure())
      }
      const timer = setTimeout(() => { child.kill(); finish(false) }, 30_000)
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.length > 16_384) { child.kill(); finish(false) }
      })
      child.stdout.once('error', () => { child.kill(); finish(false) })
      child.once('error', () => finish(false))
      child.once('close', code => finish(code === 0))
    }))
  }

  protect(target: string, directory: boolean, recursive = false): void {
    this.invalidate(target, recursive)
    assertRegularPath(target, directory)
    if (process.platform === 'win32') {
      this.sid ??= this.powershell('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value')
      if (!/^S-1-\d+(?:-\d+)+$/.test(this.sid)) throw permissionFailure()
      const result = spawnSync('icacls.exe', [target, '/inheritance:r', '/grant:r', `*${this.sid}:${directory ? '(OI)(CI)F' : 'F'}`], {
        shell: false, windowsHide: true, stdio: 'ignore', timeout: 30_000,
      })
      if (result.error || result.status !== 0) throw permissionFailure()
    } else {
      const restrict = (file: string, isDirectory: boolean) => {
        const stat = fs.lstatSync(file)
        if (stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw permissionFailure()
        fs.chmodSync(file, isDirectory ? 0o700 : 0o600)
        if (isDirectory && recursive) for (const entry of fs.readdirSync(file, { withFileTypes: true })) {
          restrict(path.join(file, entry.name), entry.isDirectory())
        }
      }
      restrict(target, directory)
    }
    this.verify(target, directory, recursive)
  }

  verify(target: string, directory: boolean, recursive = false): void {
    this.invalidate(target, recursive)
    assertRegularPath(target, directory)
    if (process.platform === 'win32') {
      if (this.powershell(PRIVATE_ACL_SCRIPT, {
        STREAM_SYNC_PRIVATE_PATH: target, STREAM_SYNC_PRIVATE_RECURSIVE: recursive ? '1' : '0', STREAM_SYNC_PRIVATE_TARGETS: '',
      }) !== 'PRIVATE_OK') throw permissionFailure()
    } else {
      const stat = fs.lstatSync(target)
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) throw permissionFailure()
      if (directory && recursive) for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        this.verify(path.join(target, entry.name), entry.isDirectory(), true)
      }
    }
  }

  /** Check the same ACL rules once for a complete read, without blocking Electron main. */
  async verifyManyAsync(targets: readonly PrivatePermissionTarget[]): Promise<void> {
    try {
      if (!targets.length || targets.length > 32) throw permissionFailure()
      const selected = targets.map(target => ({ ...target, target: path.resolve(target.target) }))
      const checkedAt = this.now()
      for (const [target, result] of this.verified) {
        if (checkedAt < result.checkedAt || checkedAt - result.checkedAt >= 600_000) this.verified.delete(target)
      }
      const snapshots = selected.map(target => ({ target, fingerprint: this.fingerprint(target) }))
      const missing = snapshots.filter(({ target, fingerprint }) => target.recursive || this.verified.get(target.target)?.fingerprint !== fingerprint)
      if (!missing.length) return
      const pending = { paths: new Set(selected.map(target => target.target)), invalidated: false }
      this.checking.add(pending)
      try {
        await this.verifyManyUncachedAsync(missing.map(item => item.target))
        for (const item of snapshots) {
          if (this.fingerprint(item.target) !== item.fingerprint) throw permissionFailure()
        }
        if (pending.invalidated) throw permissionFailure()
      } catch (error) {
        for (const item of missing) this.verified.delete(item.target.target)
        throw error
      } finally { this.checking.delete(pending) }
      // An invalidation during the asynchronous check must not resurrect old success.
      for (const item of missing) if (!item.target.recursive) {
        if (this.verified.size >= 1024) this.verified.delete(this.verified.keys().next().value!)
        this.verified.set(item.target.target, { fingerprint: item.fingerprint, checkedAt })
      }
    } catch {
      // A failed read only evicts cached success. It must not invalidate newer
      // checks started after a cookie write, or stale failures cascade into them.
      for (const target of targets) this.verified.delete(path.resolve(target.target))
      throw permissionFailure()
    }
  }

  protected async verifyManyUncachedAsync(targets: readonly PrivatePermissionTarget[]): Promise<void> {
    if (process.platform === 'win32') {
      if (await this.powershellAsync(PRIVATE_ACL_SCRIPT, { STREAM_SYNC_PRIVATE_TARGETS: JSON.stringify(targets) }) !== 'PRIVATE_OK') throw permissionFailure()
    } else {
      // Use a separate verifier so synchronous verification cannot invalidate this batch.
      const uncached = new NativePrivatePermissions(this.now)
      for (const target of targets) uncached.verify(target.target, target.directory, target.recursive)
    }
  }
}

function assertRegularPath(target: string, directory: boolean): void {
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw permissionFailure()
}

/** Validate every existing component before creating or accessing a private subtree. */
export function containedPath(root: string, target: string): string {
  const base = path.resolve(root)
  const resolved = path.resolve(target)
  const relative = path.relative(base, resolved)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw permissionFailure()
  assertRegularPath(base, true)
  let cursor = base
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component)
    try {
      const stat = fs.lstatSync(cursor)
      if (stat.isSymbolicLink()) throw permissionFailure()
      const physical = path.relative(fs.realpathSync(base), fs.realpathSync(cursor))
      if (!physical || physical === '..' || physical.startsWith(`..${path.sep}`) || path.isAbsolute(physical)) throw permissionFailure()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw permissionFailure()
    }
  }
  return resolved
}

export function privateDirectory(root: string, target: string, permissions: PrivatePermissions, recursive = false): string {
  const destination = containedPath(root, target)
  let cursor = path.resolve(root)
  for (const component of path.relative(cursor, destination).split(path.sep)) {
    cursor = path.join(cursor, component)
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 })
    assertRegularPath(cursor, true)
    permissions.protect(cursor, true, cursor === destination && recursive)
  }
  return destination
}
