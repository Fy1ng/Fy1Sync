param([string]$EvidenceDirectory = '.runtime-cache\p7-20261023')
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidenceRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot $EvidenceDirectory))
if (-not $evidenceRoot.StartsWith((Join-Path $projectRoot '.runtime-cache') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer evidence must be under the local runtime cache' }
$packageVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$stagingRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.packaging'))
$reportFile = Join-Path $evidenceRoot 'installer-runtime.json'
$registryKeysBefore = @(Get-ChildItem -LiteralPath 'HKCU:\Software' | Select-Object -ExpandProperty PSChildName)
$packageReport = Get-Content -LiteralPath (Join-Path $evidenceRoot 'package-report.json') -Raw | ConvertFrom-Json
$installer = @($packageReport.artifacts | Where-Object { $_.file.EndsWith('-nsis.exe') })
if ($installer.Count -ne 1) { throw 'Expected one local NSIS artifact' }
$installerFile = [IO.Path]::GetFullPath($installer[0].file)
if ([IO.Path]::GetDirectoryName($installerFile) -ne (Join-Path $projectRoot '.release')) { throw 'Installer must be a local task artifact' }
if ([IO.Path]::GetFileName($installerFile) -ne "Fy1Sync-$packageVersion-win-x64-nsis.exe") { throw 'Unexpected Fy1Sync installer filename' }
$programsRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs'))
$installDirectory = [IO.Path]::GetFullPath((Join-Path $programsRoot 'Fy1Sync'))
if ([IO.Path]::GetDirectoryName($installDirectory) -ne $programsRoot -or [IO.Path]::GetFileName($installDirectory) -cne 'Fy1Sync') { throw 'Invalid default install target' }
if ((Test-Path -LiteralPath $programsRoot) -and ((Get-Item -LiteralPath $programsRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Default Programs directory must not be a reparse point' }

function Read-UninstallEntries {
    $locations = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($location in $locations) {
        if (Test-Path -LiteralPath $location) {
            Get-ChildItem -LiteralPath $location | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue }
        }
    }
}
$before = @(Read-UninstallEntries)
# electron-builder's UUIDv5 for cn.fy1ng.fy1sync, also used for its remembered install path.
$applicationGuid = '2d8533e3-bfed-52dc-b8ab-ea931a696833'
$existing = @($before | Where-Object { $_.DisplayName -match '^Fy1Sync(?: |$)' -or $_.PSChildName -eq $applicationGuid })
$rememberedInstall = @("HKCU:\Software\$applicationGuid", "HKLM:\Software\$applicationGuid", "HKLM:\Software\WOW6432Node\$applicationGuid" | Where-Object { Test-Path -LiteralPath $_ })
$running = @(Get-Process -Name 'Fy1Sync' -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0 -or $rememberedInstall.Count -gt 0 -or $running.Count -gt 0 -or (Test-Path -LiteralPath $installDirectory)) {
    [ordered]@{ status = 'skipped'; reason = 'An existing installed or running Fy1Sync prevents isolated installer verification'; installed = $false } | ConvertTo-Json | Set-Content -LiteralPath $reportFile
    Write-Output 'NSIS installation skipped to preserve the existing application.'
    exit 0
}
$limits = Get-Content -LiteralPath (Join-Path $stagingRoot 'install-path-limit.json') -Raw | ConvertFrom-Json
if ($installDirectory.Length -gt $limits.maximumDirectoryLength) { throw 'Default installation target exceeds the supported path length' }
$rejectedDirectory = [IO.Path]::GetFullPath((Join-Path $evidenceRoot ('rejected-install-' + [guid]::NewGuid().ToString())))
if ($rejectedDirectory.Length -le $limits.maximumDirectoryLength -or (Test-Path -LiteralPath $rejectedDirectory)) { throw 'Invalid long-path rejection fixture' }
$rejected = Start-Process -FilePath $installerFile -ArgumentList "/S /D=$rejectedDirectory" -WindowStyle Hidden -PassThru
if (-not $rejected.WaitForExit(60000)) { $rejected.Kill(); throw 'Long-path rejection timed out' }
if ($rejected.ExitCode -ne 2 -or (Test-Path -LiteralPath $rejectedDirectory) -or @(Read-UninstallEntries | Where-Object { $_.DisplayName -match '^Fy1Sync(?: |$)' }).Count -ne 0) { throw 'Installer did not reject the unsafe long destination before writing its target' }
$assistedRejected = Start-Process -FilePath $installerFile -ArgumentList "/D=$rejectedDirectory" -WindowStyle Hidden -PassThru
if (-not $assistedRejected.WaitForExit(60000)) { $assistedRejected.Kill(); throw 'Assisted long-path initialization rejection timed out' }
if ($assistedRejected.ExitCode -ne 2 -or (Test-Path -LiteralPath $rejectedDirectory) -or @(Read-UninstallEntries | Where-Object { $_.DisplayName -match '^Fy1Sync(?: |$)' }).Count -ne 0) { throw 'Assisted installer did not reject its unsafe initial destination before writing' }
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Fy1Sync.lnk'
$menuShortcut = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Fy1Sync.lnk'
$desktopBefore = Test-Path -LiteralPath $desktopShortcut
$menuBefore = Test-Path -LiteralPath $menuShortcut
$installed = $false
$uninstallerExitCode = $null
try {
    # No /D override: verify the product's actual default current-user destination.
    # The target was absent before this run; an existing installation is never reused.
    if (Test-Path -LiteralPath $installDirectory) { throw 'Default install target appeared during verification' }
    $process = Start-Process -FilePath $installerFile -ArgumentList '/S' -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(120000)) { $process.Kill(); throw 'Isolated installer timed out' }
    $installerExitCode = $process.ExitCode
    if ($installerExitCode -ne 0) { throw "Isolated installer failed: $installerExitCode" }
    $uninstaller = Join-Path $installDirectory 'Uninstall Fy1Sync.exe'
    if (-not (Test-Path -LiteralPath (Join-Path $installDirectory 'Fy1Sync.exe')) -or -not (Test-Path -LiteralPath $uninstaller)) { throw 'Installed payload or uninstaller missing' }
    $installed = $true
    $entries = @(Read-UninstallEntries | Where-Object { $_.DisplayName -match '^Fy1Sync(?: |$)' })
    $expectedUninstall = '"' + $uninstaller + '" /currentuser'
    if ($entries.Count -ne 1 -or $entries[0].PSPath -notmatch 'HKEY_CURRENT_USER' -or $entries[0].UninstallString -ne $expectedUninstall -or $entries[0].DisplayVersion -ne $packageVersion) { throw 'Installer registry is not isolated to current user and target directory' }
    if ((Test-Path -LiteralPath $desktopShortcut) -ne $desktopBefore -or (Test-Path -LiteralPath $menuShortcut) -ne $menuBefore) { throw 'Installer unexpectedly changed a shortcut' }
    $installedRegistryKeys = @(Get-ChildItem -LiteralPath 'HKCU:\Software' | Where-Object { $_.PSChildName -notin $registryKeysBefore } | Where-Object { (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).InstallLocation -eq $installDirectory } | Select-Object -ExpandProperty PSPath)
    $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru
    if (-not $uninstall.WaitForExit(120000)) { $uninstall.Kill(); throw 'Isolated uninstaller timed out' }
    $uninstallerExitCode = $uninstall.ExitCode
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        $left = @(Read-UninstallEntries | Where-Object { $_.DisplayName -match '^Fy1Sync(?: |$)' })
        if ($left.Count -eq 0 -and -not (Test-Path -LiteralPath $installDirectory)) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($left.Count -ne 0 -or (Test-Path -LiteralPath (Join-Path $installDirectory 'Fy1Sync.exe'))) { throw 'Isolated uninstaller did not remove its registry/payload' }
    $remainingFiles = if (Test-Path -LiteralPath $installDirectory) { @(Get-ChildItem -LiteralPath $installDirectory -Recurse -Force -File).Count } else { 0 }
    if ($remainingFiles -ne 0) { throw 'Isolated uninstaller left installed files behind' }
    if (Test-Path -LiteralPath $installDirectory) { throw 'Isolated uninstaller left its target directory behind' }
    if (@($installedRegistryKeys | Where-Object { Test-Path -LiteralPath $_ }).Count -ne 0) { throw 'Isolated uninstaller left its application registry key behind' }
    if ((Test-Path -LiteralPath $desktopShortcut) -ne $desktopBefore -or (Test-Path -LiteralPath $menuShortcut) -ne $menuBefore) { throw 'Uninstaller unexpectedly changed a shortcut' }
    [ordered]@{ status = 'passed'; installerExitCode = $installerExitCode; uninstallerExitCode = $uninstallerExitCode; installed = $true; uninstalled = $true; remainingFiles = $remainingFiles; targetDirectoryRemoved = $true; applicationRegistryKeysRemoved = $installedRegistryKeys.Count; currentUserOnly = $true; shortcutsUnchanged = $true; isolatedTarget = $installDirectory; defaultInstallDirectoryVerified = $true; productName = 'Fy1Sync'; installerFilename = [IO.Path]::GetFileName($installerFile); appNeverLaunched = $true; longPathRejected = $true; longPathExitCode = $rejected.ExitCode; assistedLongPathExitCode = $assistedRejected.ExitCode; rejectedTarget = $rejectedDirectory; rejectedTargetNeverCreated = $true; maximumDirectoryLength = $limits.maximumDirectoryLength; longestRelativePath = $limits.longestRelative } | ConvertTo-Json | Set-Content -LiteralPath $reportFile
    Write-Output 'Isolated current-user NSIS installation and uninstallation passed.'
} catch {
    [ordered]@{ status = 'failed'; installed = $installed; isolatedTarget = $installDirectory; error = $_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $reportFile
    throw
} finally {
    # Remove only a proven, disposable, now-uninstalled task directory if it remains empty.
    if ($installed -and $uninstallerExitCode -eq 0 -and (Test-Path -LiteralPath $installDirectory) -and [IO.Path]::GetDirectoryName($installDirectory) -eq $programsRoot -and [IO.Path]::GetFileName($installDirectory) -ceq 'Fy1Sync') {
        if (@(Get-ChildItem -LiteralPath $installDirectory -Force).Count -eq 0) { Remove-Item -LiteralPath $installDirectory }
    }
    if ((Test-Path -LiteralPath $rejectedDirectory) -and [IO.Path]::GetDirectoryName($rejectedDirectory) -eq $evidenceRoot -and @(Get-ChildItem -LiteralPath $rejectedDirectory -Force).Count -eq 0) { Remove-Item -LiteralPath $rejectedDirectory }
}
