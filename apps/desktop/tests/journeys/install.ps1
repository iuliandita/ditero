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
& powershell -NoProfile -File apps/desktop/tests/journeys/windows-notification-count.ps1 -Diagnostics | Set-Content (Join-Path $out 'evidence/notification-platform.json')
if ($LASTEXITCODE -ne 0) { throw 'Notification platform diagnostic failed' }
