#Requires -Version 7.0
param(
    [ValidateSet('x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc')]
    [string] $Target = 'x86_64-pc-windows-msvc',
    [ValidateSet('debug', 'release')]
    [string] $Profile = 'release'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$out = Join-Path $env:RUNNER_TEMP 'desktop-smoke'
New-Item $out -ItemType Directory -Force | Out-Null
$bundle = Join-Path $repo "apps/desktop/src-tauri/target/$Target/$Profile/bundle/nsis"
$installers = @(Get-ChildItem $bundle -Filter '*.exe' -File)
if ($installers.Count -ne 1) { throw 'Expected exactly one NSIS installer' }
$installDir = Join-Path $out 'installed'
# NSIS requires /D to be last, without quotes even if the path contains spaces.
$setup = Start-Process $installers[0].FullName -ArgumentList "/S /D=$installDir" -PassThru
try {
    if (-not $setup.WaitForExit(180000)) { throw 'Installer exceeded 180 seconds' }
    if ($setup.ExitCode -ne 0) { throw "Installer failed: $($setup.ExitCode)" }
} finally {
    if (-not $setup.HasExited) { Stop-Process -Id $setup.Id -Force }
}
$installed = Join-Path $installDir 'ditero-desktop.exe'
$built = Join-Path $repo "apps/desktop/src-tauri/target/$Target/$Profile/ditero-desktop.exe"
if ((Get-FileHash $installed).Hash -ne (Get-FileHash $built).Hash) {
    throw 'Installed executable differs from built executable'
}
$reader = [IO.BinaryReader]::new([IO.File]::OpenRead($installed))
try {
    if ($reader.ReadUInt16() -ne 0x5A4D) { throw 'Missing DOS signature' }
    $reader.BaseStream.Position = 0x3C
    $offset = $reader.ReadUInt32()
    $reader.BaseStream.Position = $offset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw 'Missing PE signature' }
    $machine = $reader.ReadUInt16()
    $expected = if ($Target -eq 'aarch64-pc-windows-msvc') { 0xAA64 } else { 0x8664 }
    if ($machine -ne $expected) { throw ('Unexpected PE machine: 0x{0:X4}' -f $machine) }
    ('PE machine: 0x{0:X4}' -f $machine) | Set-Content (Join-Path $out 'architecture.txt')
} finally { $reader.Dispose() }
$process = Start-Process $installed -PassThru
try {
    Start-Sleep 20
    $process.Refresh()
    if ($process.HasExited) { throw "Installed application exited: $($process.ExitCode)" }
    $process.MainWindowTitle | Set-Content (Join-Path $out 'window.txt')
    if ($process.MainWindowTitle -ne 'Ditero') { throw 'Ditero window did not appear' }
} finally {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
}
Write-Output 'NSIS installation, payload architecture, byte identity and startup passed'
