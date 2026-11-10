$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'NSIS 安装/卸载测试只允许在一次性 Windows CI 主机运行' }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$installRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'e2e/.data/nsis'))
$dataRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'e2e/.data'))
if (!$installRoot.StartsWith($dataRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'NSIS 测试目录越界' }
if (Test-Path -LiteralPath $installRoot) { throw 'NSIS 测试目录必须为空且尚未创建' }
function Get-NsisInstallation {
  Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'Fy1Sync*' }
}
if (@(Get-NsisInstallation).Count -ne 0) { throw '已有 Fy1Sync 安装, 不运行可丢弃环境的安装/卸载测试' }
$installer = Join-Path $projectRoot ".release/Fy1Sync-$version-win-x64-nsis.exe"
$unpacked = [IO.Path]::GetFullPath((Join-Path $projectRoot '.release/win-unpacked'))
$payloadFiles = 0
$installed = $false
try {
  $installerProcess = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installRoot") -WindowStyle Hidden -PassThru -Wait
  if ($installerProcess.ExitCode -ne 0) { throw "NSIS 安装失败, exit $($installerProcess.ExitCode)" }
  $installed = $true
  $entries = @(Get-NsisInstallation)
  if ($entries.Count -ne 1 -or $entries[0].DisplayVersion -ne $version -or !$entries[0].UninstallString.Contains($installRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'NSIS 卸载项版本或安装目录不符' }
  foreach ($file in Get-ChildItem -LiteralPath $unpacked -File -Recurse) {
    $relative = $file.FullName.Substring($unpacked.Length).TrimStart([IO.Path]::DirectorySeparatorChar)
    $destination = Join-Path $installRoot $relative
    if (!(Test-Path -LiteralPath $destination) -or (Get-Item -LiteralPath $destination).Length -ne $file.Length -or (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) { throw "NSIS 安装资源与已校验发布目录不一致: $relative" }
    $payloadFiles++
  }
} finally {
  if ($installed) {
    $uninstaller = Join-Path $installRoot 'Uninstall Fy1Sync.exe'
    if (!(Test-Path -LiteralPath $uninstaller)) { throw 'NSIS 卸载程序缺失' }
    $uninstallerProcess = Start-Process -FilePath $uninstaller -ArgumentList @('/S', '/currentuser') -WindowStyle Hidden -PassThru -Wait
    if ($uninstallerProcess.ExitCode -ne 0) { throw "NSIS 卸载失败, exit $($uninstallerProcess.ExitCode)" }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ((Test-Path -LiteralPath (Join-Path $installRoot 'Fy1Sync.exe')) -or @(Get-NsisInstallation).Count -ne 0) {
      if ([DateTime]::UtcNow -ge $deadline) { throw 'NSIS 卸载未在期限内清理程序和卸载项' }
      Start-Sleep -Milliseconds 250
    }
  }
}
$evidence = Join-Path $projectRoot '.runtime-cache/release-ci'
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
@{ version = $version; target = 'win32-x64'; payloadFiles = $payloadFiles; installation = 'passed'; uninstallation = 'passed'; environment = 'disposable-ci' } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'nsis-smoke.json') -Encoding utf8
Write-Host '一次性环境中的 NSIS 安装, 资源校验和卸载检查通过'
