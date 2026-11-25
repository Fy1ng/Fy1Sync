import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { BrowserImportCloseResult } from './browserImportContracts'
import type { DiscoveredBrowserProfile } from './browserProfiles'
import { BrowserImportError, importAbort } from './browserImportError'
import { powershellEnvironment } from './privateStorage'

export interface BrowserProcessTarget {
  imageName: 'msedge.exe' | 'chrome.exe' | 'firefox.exe'
  requiredPathFragment?: string
  excludedPathFragments?: readonly string[]
  expectedUserDataDir?: string
}

export type BrowserCloseFunction = (profile: DiscoveredBrowserProfile, signal: AbortSignal) => Promise<BrowserImportCloseResult>

export interface BrowserCloserOptions {
  platform?: NodeJS.Platform
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  waitForUnlock?: (database: string, signal: AbortSignal) => Promise<void>
  gracefulTimeoutMs?: number
  forceTimeoutMs?: number
  timeoutMs?: number
}

const EDGE_NON_STABLE = ['\\microsoft\\edge beta\\', '\\microsoft\\edge dev\\', '\\microsoft\\edge sxs\\'] as const
const CHROME_NON_STABLE = ['\\google\\chrome beta\\', '\\google\\chrome dev\\', '\\google\\chrome sxs\\'] as const

const CHANNEL_TARGETS: Record<string, Omit<BrowserProcessTarget, 'expectedUserDataDir'>> = {
  'Microsoft Edge': { imageName: 'msedge.exe', excludedPathFragments: EDGE_NON_STABLE },
  'Microsoft Edge Beta': { imageName: 'msedge.exe', requiredPathFragment: '\\microsoft\\edge beta\\' },
  'Microsoft Edge Dev': { imageName: 'msedge.exe', requiredPathFragment: '\\microsoft\\edge dev\\' },
  'Google Chrome': { imageName: 'chrome.exe', excludedPathFragments: CHROME_NON_STABLE },
  'Google Chrome Beta': { imageName: 'chrome.exe', requiredPathFragment: '\\google\\chrome beta\\' },
  'Google Chrome Dev': { imageName: 'chrome.exe', requiredPathFragment: '\\google\\chrome dev\\' },
  'Google Chrome Canary': { imageName: 'chrome.exe', requiredPathFragment: '\\google\\chrome sxs\\' },
  'Mozilla Firefox': { imageName: 'firefox.exe' },
}

export function normalizeWindowsPath(value: string): string {
  return value.trim().replace(/^"+|"+$/g, '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

export function resolveBrowserProcessTarget(
  profile: Pick<DiscoveredBrowserProfile, 'browser' | 'browserName' | 'directory'>,
): BrowserProcessTarget | null {
  const base = CHANNEL_TARGETS[profile.browserName]
  if (!base) return null
  if (profile.browser === 'firefox') return { ...base }
  const userDataDir = path.win32.dirname(profile.directory)
  return {
    ...base,
    ...(userDataDir && userDataDir !== '.' ? { expectedUserDataDir: normalizeWindowsPath(userDataDir) } : {}),
  }
}

const CLOSE_BROWSER_SCRIPT = `
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'

function Normalize-PathValue([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return '' }
  return $value.Trim().Trim('"').Replace('/', '\\').TrimEnd('\\').ToLowerInvariant()
}

function Get-UserDataDir([string]$commandLine) {
  if ([string]::IsNullOrWhiteSpace($commandLine)) { return $null }
  $match = [regex]::Match($commandLine, '(?:^|\\s)--user-data-dir(?:=|\\s+)(?:"([^"]+)"|([^\\s"]+))', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $match.Success) { return $null }
  if ($match.Groups[1].Success) { return Normalize-PathValue $match.Groups[1].Value }
  return Normalize-PathValue $match.Groups[2].Value
}

$req = ([Console]::In.ReadToEnd()) | ConvertFrom-Json
$image = [string]$req.imageName
if ($image -notin @('msedge.exe', 'chrome.exe', 'firefox.exe')) { throw 'Invalid browser image' }
$requiredFragment = if ($req.requiredPathFragment) { [string]$req.requiredPathFragment } else { $null }
$excludedFragments = @()
if ($req.excludedPathFragments) { $excludedFragments = @($req.excludedPathFragments | ForEach-Object { [string]$_ }) }
$expectedUserDataDir = if ($req.expectedUserDataDir) { Normalize-PathValue ([string]$req.expectedUserDataDir) } else { $null }
$gracefulTimeoutMs = if ($req.gracefulTimeoutMs) { [int]$req.gracefulTimeoutMs } else { 3500 }
$forceTimeoutMs = if ($req.forceTimeoutMs) { [int]$req.forceTimeoutMs } else { 3000 }
$sessionId = (Get-Process -Id $PID).SessionId

function Get-TargetPids {
  $searcher = New-Object System.Management.ManagementObjectSearcher("SELECT ProcessId, ParentProcessId, ExecutablePath, CommandLine FROM Win32_Process WHERE Name = '$image' AND SessionId = $sessionId")
  $rows = @()
  try {
    foreach ($item in $searcher.Get()) {
      $rows += [pscustomobject]@{
        ProcessId = [int]$item['ProcessId']
        ParentId = [int]$item['ParentProcessId']
        Path = if ($null -ne $item['ExecutablePath']) { Normalize-PathValue ([string]$item['ExecutablePath']) } else { '' }
        Cmd = if ($null -ne $item['CommandLine']) { [string]$item['CommandLine'] } else { '' }
      }
    }
  } finally {
    $searcher.Dispose()
  }

  $excludedPids = New-Object 'System.Collections.Generic.HashSet[int]'
  if ($expectedUserDataDir) {
    foreach ($row in $rows) {
      $dir = Get-UserDataDir $row.Cmd
      if ($null -ne $dir -and $dir -ne $expectedUserDataDir) {
        [void]$excludedPids.Add($row.ProcessId)
      }
    }
    $changed = $true
    while ($changed) {
      $changed = $false
      foreach ($row in $rows) {
        if (-not $excludedPids.Contains($row.ProcessId) -and $excludedPids.Contains($row.ParentId)) {
          [void]$excludedPids.Add($row.ProcessId)
          $changed = $true
        }
      }
    }
  }

  $matched = @()
  foreach ($row in $rows) {
    if ($excludedPids.Contains($row.ProcessId)) { continue }
    if ($row.Path) {
      if ($requiredFragment -and $row.Path.IndexOf($requiredFragment, [System.StringComparison]::Ordinal) -lt 0) { continue }
      $isExcluded = $false
      foreach ($frag in $excludedFragments) {
        if ($row.Path.IndexOf($frag, [System.StringComparison]::Ordinal) -ge 0) { $isExcluded = $true; break }
      }
      if ($isExcluded) { continue }
    } elseif ($requiredFragment) {
      continue
    }
    $matched += $row.ProcessId
  }
  return @($matched)
}

function Has-VisibleWindow([int[]]$pids) {
  foreach ($id in $pids) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) { return $true }
  }
  return $false
}

$initial = @(Get-TargetPids)
if ($initial.Count -eq 0) {
  @{ status = 'not-running'; initialCount = 0; remainingCount = 0 } | ConvertTo-Json -Compress
  exit 0
}

$hadWindow = $false
foreach ($id in $initial) {
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
    $hadWindow = $true
    $null = $proc.CloseMainWindow()
  }
}

$remaining = $initial
if ($hadWindow) {
  $graceWatch = [System.Diagnostics.Stopwatch]::StartNew()
  $windowsGoneAt = -1
  while ($graceWatch.ElapsedMilliseconds -lt $gracefulTimeoutMs) {
    Start-Sleep -Milliseconds 200
    $remaining = @(Get-TargetPids)
    if ($remaining.Count -eq 0) {
      @{ status = 'closed'; initialCount = $initial.Count; remainingCount = 0 } | ConvertTo-Json -Compress
      exit 0
    }
    if (-not (Has-VisibleWindow $remaining)) {
      if ($windowsGoneAt -lt 0) { $windowsGoneAt = $graceWatch.ElapsedMilliseconds }
      elseif (($graceWatch.ElapsedMilliseconds - $windowsGoneAt) -ge 500) { break }
    }
  }
}

$remaining = @(Get-TargetPids)
if ($remaining.Count -eq 0) {
  @{ status = 'closed'; initialCount = $initial.Count; remainingCount = 0 } | ConvertTo-Json -Compress
  exit 0
}

foreach ($id in $remaining) {
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}

$forceWatch = [System.Diagnostics.Stopwatch]::StartNew()
while ($forceWatch.ElapsedMilliseconds -lt $forceTimeoutMs) {
  Start-Sleep -Milliseconds 200
  $remaining = @(Get-TargetPids)
  if ($remaining.Count -eq 0) {
    @{ status = 'closed'; initialCount = $initial.Count; remainingCount = 0 } | ConvertTo-Json -Compress
    exit 0
  }
}

@{ status = 'failed'; initialCount = $initial.Count; remainingCount = $remaining.Count } | ConvertTo-Json -Compress
`

const ENCODED_CLOSE_SCRIPT = Buffer.from(CLOSE_BROWSER_SCRIPT, 'utf16le').toString('base64')

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new BrowserImportError('browser-import-cancelled')); return }
    const onAbort = () => { clearTimeout(timer); reject(new BrowserImportError('browser-import-cancelled')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function defaultWaitForUnlock(database: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 1500
  while (true) {
    importAbort(signal)
    try {
      const handle = await fs.open(database, 'r')
      await handle.close()
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      if (Date.now() >= deadline) throw new BrowserImportError('browser-import-close-failed')
      await delay(150, signal)
    }
  }
}

/** Closes the Windows browser channel matching a discovered profile, gracefully first then forcing lingering background processes. */
export function browserCloser(options: BrowserCloserOptions = {}): BrowserCloseFunction {
  const platform = options.platform ?? process.platform
  const spawnProcess = options.spawn ?? spawn
  const waitForUnlock = options.waitForUnlock ?? defaultWaitForUnlock
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 3500
  const forceTimeoutMs = options.forceTimeoutMs ?? 3000
  const timeoutMs = options.timeoutMs ?? 15_000

  return async (profile, signal) => {
    importAbort(signal)
    if (platform !== 'win32') throw new BrowserImportError('browser-import-unsupported')
    const target = resolveBrowserProcessTarget(profile)
    if (!target) throw new BrowserImportError('browser-import-close-failed')

    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const status = await new Promise<'closed' | 'not-running'>((resolve, reject) => {
      const child = spawnProcess(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_CLOSE_SCRIPT], {
        shell: false,
        windowsHide: true,
        env: powershellEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let settled = false
      const finish = (error?: BrowserImportError, value?: 'closed' | 'not-running') => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        if (error) { child.kill(); reject(error) }
        else resolve(value!)
      }
      const onAbort = () => finish(new BrowserImportError('browser-import-cancelled'))
      const timer = setTimeout(() => finish(new BrowserImportError('browser-import-close-failed')), timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      child.stderr?.resume()
      child.stdin?.on('error', () => {})
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (stdout.length > 8192) finish(new BrowserImportError('browser-import-close-failed'))
      })
      child.once('error', () => finish(new BrowserImportError('browser-import-close-failed')))
      child.once('close', code => {
        if (settled) return
        if (code !== 0) { finish(new BrowserImportError('browser-import-close-failed')); return }
        try {
          const parsed = JSON.parse(stdout.trim()) as { status?: unknown }
          if (parsed.status === 'closed' || parsed.status === 'not-running') finish(undefined, parsed.status)
          else finish(new BrowserImportError('browser-import-close-failed'))
        } catch {
          finish(new BrowserImportError('browser-import-close-failed'))
        }
      })
      if (signal.aborted) { onAbort(); return }
      const payload = JSON.stringify({
        imageName: target.imageName,
        requiredPathFragment: target.requiredPathFragment ?? null,
        excludedPathFragments: target.excludedPathFragments ?? [],
        expectedUserDataDir: target.expectedUserDataDir ?? null,
        gracefulTimeoutMs,
        forceTimeoutMs,
      })
      child.stdin?.end(payload, 'utf8')
    })

    importAbort(signal)
    if (status === 'closed' && profile.browser !== 'firefox') {
      await waitForUnlock(profile.database, signal)
    }
    importAbort(signal)
    return { status, browserName: profile.browserName }
  }
}
