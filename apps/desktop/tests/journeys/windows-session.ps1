param([switch]$Worker, [string]$State = (Join-Path $env:RUNNER_TEMP 'desktop-journeys'))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$environmentFile = Join-Path $State 'private/session-environment.json'
$resultFile = Join-Path $State 'private/session-result.json'
$logFile = Join-Path $State 'evidence/session.log'
if ($Worker) {
    $context = Get-Content $environmentFile -Raw | ConvertFrom-Json
    foreach ($property in $context.environment.PSObject.Properties) { [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process') }
    Set-Location $context.root
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    @{elevated=$elevated; method='interactive-limited-task'} | ConvertTo-Json | Set-Content (Join-Path $State 'evidence/session-privileges.json')
    $code = 1
    try {
        if ($elevated) { throw 'Journey must run as a normal, unelevated desktop application' }
        & $context.node --experimental-strip-types apps/desktop/tests/journeys/run.ts *> $logFile
        $code = $LASTEXITCODE
    } catch { $_ | Out-String | Add-Content $logFile }
    finally {
        @{exitCode=$code} | ConvertTo-Json | Set-Content ($resultFile + '.tmp')
        Move-Item ($resultFile + '.tmp') $resultFile -Force
    }
    exit $code
}
$environment = @{}
Get-ChildItem Env: | Where-Object {$_.Name -match '^(PATH|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|TEMP|TMP|RUNNER_TEMP|RUNNER_OS|GITHUB_SHA|NODE_EXTRA_CA_CERTS|JOURNEY_.*)$'} | ForEach-Object {$environment[$_.Name]=$_.Value}
@{environment=$environment; root=(Get-Location).Path; node=(Get-Command node).Source} | ConvertTo-Json -Depth 4 | Set-Content $environmentFile
$taskName = 'Ditero-Journey-' + [Guid]::NewGuid().ToString('N')
$script = $PSCommandPath
$action = New-ScheduledTaskAction -Execute (Get-Command pwsh).Source -Argument "-NoProfile -File `"$script`" -Worker -State `"$State`""
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 14) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
    Start-ScheduledTask -TaskName $taskName
    $deadline = [DateTime]::UtcNow.AddMinutes(14)
    while (-not (Test-Path $resultFile) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Seconds 1 }
    if (Test-Path $logFile) { Get-Content $logFile }
    if (-not (Test-Path $resultFile)) { throw 'Limited desktop session did not finish within its deadline' }
    $result = Get-Content $resultFile -Raw | ConvertFrom-Json
    if ($result.exitCode -ne 0) { throw "Limited desktop journey exit $($result.exitCode)" }
} finally {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -ne $task) {
        if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
}
