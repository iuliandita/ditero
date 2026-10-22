Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$out = Join-Path $env:RUNNER_TEMP 'desktop-journeys'
$bundle = "apps/desktop/src-tauri/target/$env:DESKTOP_TARGET/debug/bundle/nsis"
$installer = @(Get-ChildItem $bundle -Filter '*.exe' -File)
if ($installer.Count -ne 1) { throw 'Expected one development NSIS installer' }
$destination = Join-Path $env:LOCALAPPDATA 'Ditero Journey'
$process = Start-Process $installer[0].FullName -ArgumentList "/S /D=$destination" -PassThru
if (-not $process.WaitForExit(180000)) { throw 'Installer timeout' }
if ($process.ExitCode -ne 0) { throw "Installer exit $($process.ExitCode)" }
$installed = Join-Path $destination 'ditero-desktop.exe'
$built = "apps/desktop/src-tauri/target/$env:DESKTOP_TARGET/debug/ditero-desktop.exe"
if ((Get-FileHash $installed).Hash -ne (Get-FileHash $built).Hash) { throw 'Installed bytes differ' }
@{application=$installed; installer=$installer[0].Name} | ConvertTo-Json | Set-Content (Join-Path $out 'installed.json')
$os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber
$hosts = @(Get-Process | Where-Object {$_.ProcessName -match 'Shell|explorer|Notification'} | Select-Object ProcessName, SessionId)
$systemApps = Join-Path $env:WINDIR 'SystemApps'
$packages = if (Test-Path $systemApps) { @(Get-ChildItem $systemApps -Directory -Filter '*ShellExperienceHost*' | Select-Object Name, FullName) } else { @() }
$settingsPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings'
$settings = if (Test-Path $settingsPath) { Get-ItemProperty $settingsPath | Select-Object NOC_GLOBAL_SETTING_TOASTS_ENABLED, NOC_GLOBAL_SETTING_ALLOW_TOASTS_ABOVE_LOCK } else { $null }
@{os=$os; hosts=$hosts; packages=$packages; settings=$settings} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $out 'evidence/notification-platform.json')
$registered = & powershell -NoProfile -Command '$ErrorActionPreference="Stop"; @{packages=@(Get-AppxPackage -Name "*ShellExperienceHost*" | Select-Object Name,Status,InstallLocation)} | ConvertTo-Json -Depth 4'
if ($LASTEXITCODE -ne 0) { throw 'Per-user notification shell query failed' }
$registered | Set-Content (Join-Path $out 'evidence/notification-shell-registration.json')
$shell = New-Object -ComObject Shell.Application
$programs = [Environment]::GetFolderPath('Programs')
$shortcuts = @(Get-ChildItem $programs -Recurse -File -Filter 'Ditero.lnk' | ForEach-Object {
    $item = $shell.Namespace($_.DirectoryName).ParseName($_.Name)
    @{name=$_.Name; appId=$item.ExtendedProperty('System.AppUserModel.ID')}
})
@{shortcuts=$shortcuts} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $out 'evidence/notification-shortcuts.json')
if (@($shortcuts | Where-Object {$_.appId -eq 'io.ditero.desktop'}).Count -ne 1) { throw 'Installed notification shortcut identity missing or duplicated' }
& pwsh -NoProfile -File apps/desktop/tests/journeys/windows-notifications.ps1 -Mode prepare
if ($LASTEXITCODE -ne 0) { throw 'Windows notification UI preparation failed' }
