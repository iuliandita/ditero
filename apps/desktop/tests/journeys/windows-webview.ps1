param(
    [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
    [Parameter(Mandatory)][string]$Profile
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($elevated) {
    # Elevated WebView2 ignores environment and per-user argument overrides.
    $values = @{
        AdditionalBrowserArguments = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$Port --disable-gpu"
        UserDataFolder = $Profile
    }
    foreach ($name in $values.Keys) {
        $key = "HKLM:\Software\Policies\Microsoft\Edge\WebView2\$name"
        New-Item $key -Force | Out-Null
        New-ItemProperty $key -Name 'ditero-desktop.exe' -Value $values[$name] -PropertyType String -Force | Out-Null
    }
}
@{elevated=$elevated; appScopedMachinePolicy=$elevated; port=$Port} | ConvertTo-Json | Set-Content (Join-Path $env:RUNNER_TEMP 'desktop-journeys/evidence/windows-webview-policy.json')
