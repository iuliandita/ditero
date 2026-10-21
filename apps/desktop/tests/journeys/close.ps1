param([Parameter(Mandatory=$true)][string] $Application)
$ErrorActionPreference = 'Stop'
$processes = @(Get-Process -Name 'ditero-desktop' | Where-Object { $_.Path -eq $Application })
if ($processes.Count -ne 1) { throw 'Expected exactly one installed application process' }
$process = $processes[0]
if (-not $process.CloseMainWindow()) { throw 'Native close request failed' }
if (-not $process.WaitForExit(30000)) { throw 'Managed close did not finish within 30 seconds' }
