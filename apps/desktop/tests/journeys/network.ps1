param([Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$Name)
$ErrorActionPreference = 'Stop'
$listeners = @(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq $Port | ForEach-Object {
    $owner = Get-Process -Id $_.OwningProcess
    @{address=$_.LocalAddress; port=$_.LocalPort; pid=$_.OwningProcess; process=$owner.ProcessName}
})
@{port=$Port; listeners=$listeners} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $env:RUNNER_TEMP "desktop-journeys/evidence/network-$Name.json")
