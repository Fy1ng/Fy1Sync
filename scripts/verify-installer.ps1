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
$existing = @($before | Where-Object { $_.DisplayName -match '^(?:Stream Syncer|stream-syncer)(?: |$)' })
$running = @(Get-Process -Name 'Stream Syncer' -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0 -or $running.Count -gt 0) {
    [ordered]@{ status = 'skipped'; reason = 'An existing installed or running Stream Syncer prevents isolated installer verification'; installed = $false } | ConvertTo-Json | Set-Content -LiteralPath $reportFile
    Write-Output 'NSIS installation skipped to preserve the existing application.'
    exit 0
}
$limits = Get-Content -LiteralPath (Join-Path $stagingRoot 'install-path-limit.json') -Raw | ConvertFrom-Json
$installDirectory = [IO.Path]::GetFullPath((Join-Path $stagingRoot ('i-' + [guid]::NewGuid().ToString('N').Substring(0, 8))))
if ([IO.Path]::GetDirectoryName($installDirectory) -ne $stagingRoot -or (Test-Path -LiteralPath $installDirectory) -or $installDirectory.Length -gt $limits.maximumDirectoryLength) { throw 'Invalid isolated short install target' }
$rejectedDirectory = [IO.Path]::GetFullPath((Join-Path $evidenceRoot ('rejected-install-' + [guid]::NewGuid().ToString())))
if ($rejectedDirectory.Length -le $limits.maximumDirectoryLength -or (Test-Path -LiteralPath $rejectedDirectory)) { throw 'Invalid long-path rejection fixture' }
$rejected = Start-Process -FilePath $installerFile -ArgumentList "/S /D=$rejectedDirectory" -WindowStyle Hidden -PassThru
if (-not $rejected.WaitForExit(60000)) { $rejected.Kill(); throw 'Long-path rejection timed out' }
if ($rejected.ExitCode -ne 2 -or (Test-Path -LiteralPath $rejectedDirectory) -or @(Read-UninstallEntries | Where-Object { $_.DisplayName -match '^Stream Syncer(?: |$)' }).Count -ne 0) { throw 'Installer did not reject the unsafe long destination before writing its target' }
$assistedRejected = Start-Process -FilePath $installerFile -ArgumentList "/D=$rejectedDirectory" -WindowStyle Hidden -PassThru
if (-not $assistedRejected.WaitForExit(60000)) { $assistedRejected.Kill(); throw 'Assisted long-path initialization rejection timed out' }
if ($assistedRejected.ExitCode -ne 2 -or (Test-Path -LiteralPath $rejectedDirectory) -or @(Read-UninstallEntries | Where-Object { $_.DisplayName -match '^Stream Syncer(?: |$)' }).Count -ne 0) { throw 'Assisted installer did not reject its unsafe initial destination before writing' }
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Stream Syncer.lnk'
$menuShortcut = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Stream Syncer.lnk'
$desktopBefore = Test-Path -LiteralPath $desktopShortcut
$menuBefore = Test-Path -LiteralPath $menuShortcut
$installed = $false
$uninstallerExitCode = $null
try {
    # /D must be last; NSIS treats the rest of the command line as the destination, including spaces.
    $process = Start-Process -FilePath $installerFile -ArgumentList "/S /D=$installDirectory" -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(120000)) { $process.Kill(); throw 'Isolated installer timed out' }
    $installerExitCode = $process.ExitCode
    if ($installerExitCode -ne 0) { throw "Isolated installer failed: $installerExitCode" }
    $uninstaller = Join-Path $installDirectory 'Uninstall Stream Syncer.exe'
    if (-not (Test-Path -LiteralPath (Join-Path $installDirectory 'Stream Syncer.exe')) -or -not (Test-Path -LiteralPath $uninstaller)) { throw 'Installed payload or uninstaller missing' }
    $installed = $true
    $entries = @(Read-UninstallEntries | Where-Object { $_.DisplayName -match '^Stream Syncer(?: |$)' })
    $expectedUninstall = '"' + $uninstaller + '" /currentuser'
    if ($entries.Count -ne 1 -or $entries[0].PSPath -notmatch 'HKEY_CURRENT_USER' -or $entries[0].UninstallString -ne $expectedUninstall -or $entries[0].DisplayVersion -ne $packageVersion) { throw 'Installer registry is not isolated to current user and target directory' }
    if ((Test-Path -LiteralPath $desktopShortcut) -ne $desktopBefore -or (Test-Path -LiteralPath $menuShortcut) -ne $menuBefore) { throw 'Installer unexpectedly changed a shortcut' }
    $installedRegistryKeys = @(Get-ChildItem -LiteralPath 'HKCU:\Software' | Where-Object { $_.PSChildName -notin $registryKeysBefore } | Where-Object { (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).InstallLocation -eq $installDirectory } | Select-Object -ExpandProperty PSPath)
    $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru
    if (-not $uninstall.WaitForExit(120000)) { $uninstall.Kill(); throw 'Isolated uninstaller timed out' }
    $uninstallerExitCode = $uninstall.ExitCode
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        $left = @(Read-UninstallEntries | Where-Object { $_.DisplayName -match '^Stream Syncer(?: |$)' })
        if ($left.Count -eq 0 -and -not (Test-Path -LiteralPath $installDirectory)) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($left.Count -ne 0 -or (Test-Path -LiteralPath (Join-Path $installDirectory 'Stream Syncer.exe'))) { throw 'Isolated uninstaller did not remove its registry/payload' }
    $remainingFiles = if (Test-Path -LiteralPath $installDirectory) { @(Get-ChildItem -LiteralPath $installDirectory -Recurse -Force -File).Count } else { 0 }
    if ($remainingFiles -ne 0) { throw 'Isolated uninstaller left installed files behind' }
    if (Test-Path -LiteralPath $installDirectory) { throw 'Isolated uninstaller left its target directory behind' }
    if (@($installedRegistryKeys | Where-Object { Test-Path -LiteralPath $_ }).Count -ne 0) { throw 'Isolated uninstaller left its application registry key behind' }
    if ((Test-Path -LiteralPath $desktopShortcut) -ne $desktopBefore -or (Test-Path -LiteralPath $menuShortcut) -ne $menuBefore) { throw 'Uninstaller unexpectedly changed a shortcut' }
    [ordered]@{ status = 'passed'; installerExitCode = $installerExitCode; uninstallerExitCode = $uninstallerExitCode; installed = $true; uninstalled = $true; remainingFiles = $remainingFiles; targetDirectoryRemoved = $true; applicationRegistryKeysRemoved = $installedRegistryKeys.Count; currentUserOnly = $true; shortcutsUnchanged = $true; isolatedTarget = $installDirectory; appNeverLaunched = $true; longPathRejected = $true; longPathExitCode = $rejected.ExitCode; assistedLongPathExitCode = $assistedRejected.ExitCode; rejectedTarget = $rejectedDirectory; rejectedTargetNeverCreated = $true; maximumDirectoryLength = $limits.maximumDirectoryLength; longestRelativePath = $limits.longestRelative } | ConvertTo-Json | Set-Content -LiteralPath $reportFile
    Write-Output 'Isolated current-user NSIS installation and uninstallation passed.'
} catch {
    [ordered]@{ status = 'failed'; installed = $installed; isolatedTarget = $installDirectory; error = $_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $reportFile
    throw
} finally {
    # Remove only a proven, disposable, now-uninstalled task directory if it remains empty.
    if ((Test-Path -LiteralPath $installDirectory) -and [IO.Path]::GetDirectoryName($installDirectory) -eq $stagingRoot -and [IO.Path]::GetFileName($installDirectory) -match '^i-[a-f0-9]{8}$') {
        if (@(Get-ChildItem -LiteralPath $installDirectory -Force).Count -eq 0) { Remove-Item -LiteralPath $installDirectory }
    }
    if ((Test-Path -LiteralPath $rejectedDirectory) -and [IO.Path]::GetDirectoryName($rejectedDirectory) -eq $evidenceRoot -and @(Get-ChildItem -LiteralPath $rejectedDirectory -Force).Count -eq 0) { Remove-Item -LiteralPath $rejectedDirectory }
}
