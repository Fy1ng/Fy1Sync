import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export interface PrivatePermissions {
  protect(target: string, directory: boolean, recursive?: boolean): void
  verify(target: string, directory: boolean, recursive?: boolean): void
}

const permissionFailure = () => new Error('无法验证账号数据的私有文件权限.')

export function powershellEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => name.toLowerCase() !== 'psmodulepath'))
}

/** Only Allow rules widen access; Chromium's own AppContainer capabilities are permitted. */
export const PRIVATE_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$items = @(Get-Item -Force -LiteralPath $env:STREAM_SYNC_PRIVATE_PATH)
if ($env:STREAM_SYNC_PRIVATE_RECURSIVE -eq '1') {
  $items += @(Get-ChildItem -Force -Recurse -LiteralPath $env:STREAM_SYNC_PRIVATE_PATH)
}
foreach ($item in $items) {
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 1 }
  $rules = @($item.GetAccessControl().GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  $allows = @($rules | Where-Object { $_.AccessControlType -eq 'Allow' })
  if (@($allows | Where-Object { $_.IdentityReference.Value -ne $sid -and -not $_.IdentityReference.Value.StartsWith('S-1-15-3-') }).Count -ne 0) { exit 1 }
  if (@($allows | Where-Object { $_.IdentityReference.Value -eq $sid -and ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl }).Count -eq 0) { exit 1 }
}
if (-not (Get-Item -Force -LiteralPath $env:STREAM_SYNC_PRIVATE_PATH).GetAccessControl().AreAccessRulesProtected) { exit 1 }
Write-Output 'PRIVATE_OK'
`

export class NativePrivatePermissions implements PrivatePermissions {
  private sid: string | undefined

  private powershell(script: string, environment: NodeJS.ProcessEnv = {}): string {
    const executable = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe'
    const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 30_000,
      env: { ...powershellEnvironment(), ...environment }, stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.error || result.status !== 0) throw permissionFailure()
    return result.stdout.trim()
  }

  protect(target: string, directory: boolean, recursive = false): void {
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
    assertRegularPath(target, directory)
    if (process.platform === 'win32') {
      if (this.powershell(PRIVATE_ACL_SCRIPT, {
        STREAM_SYNC_PRIVATE_PATH: target, STREAM_SYNC_PRIVATE_RECURSIVE: recursive ? '1' : '0',
      }) !== 'PRIVATE_OK') throw permissionFailure()
    } else {
      const stat = fs.lstatSync(target)
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) throw permissionFailure()
      if (directory && recursive) for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        this.verify(path.join(target, entry.name), entry.isDirectory(), true)
      }
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
