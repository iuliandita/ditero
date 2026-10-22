Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$items = [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('io.ditero.desktop')
@{reader='fresh-os-toast-history'; deliveredCount=$items.Count; pendingCount=0} | ConvertTo-Json -Compress
