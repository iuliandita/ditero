param([switch]$Diagnostics)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
if ($Diagnostics) {
    try {
        $setting = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('io.ditero.desktop').Setting
        @{reader='independent-winrt-process'; setting=[string]$setting} | ConvertTo-Json -Compress
    } catch {
        $inner = $_.Exception.InnerException
        $innerCode = if ($null -ne $inner) { $inner.HResult } else { $null }
        @{reader='independent-winrt-process'; hresult=$_.Exception.HResult; innerHresult=$innerCode} | ConvertTo-Json -Compress
    }
    exit 0
}
$items = [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('io.ditero.desktop')
@{reader='fresh-os-toast-history'; deliveredCount=$items.Count; pendingCount=0} | ConvertTo-Json -Compress
