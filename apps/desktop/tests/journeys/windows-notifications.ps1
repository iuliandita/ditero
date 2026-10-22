param([ValidateSet('show', 'click', 'prepare')][string]$Mode = 'click')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class JourneyNotificationMouse {
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
$evidence = Join-Path $env:RUNNER_TEMP 'desktop-journeys/evidence'
function Click-Element($element) {
    $invoke = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) { $invoke.Invoke(); return }
    $rectangle = $element.Current.BoundingRectangle
    if ($element.Current.IsOffscreen -or $rectangle.Width -le 0 -or $rectangle.Height -le 0) { throw 'OS control has no visible bounds' }
    if (-not [JourneyNotificationMouse]::SetCursorPos([int]($rectangle.X + $rectangle.Width / 2), [int]($rectangle.Y + $rectangle.Height / 2))) { throw "OS pointer positioning failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
    [JourneyNotificationMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [JourneyNotificationMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}
function Notification-Button {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($window in $windows) {
        if ($window.Current.ClassName -ne 'Shell_TrayWnd') { continue }
        $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($element in $elements) {
            if ($element.Current.Name -like 'Notifications *') { return $element }
        }
    }
    throw 'Notification center taskbar control unavailable'
}
if ($Mode -eq 'prepare') {
    $button = Notification-Button
    $before = $button.Current.Name
    $opened = $false
    if ($before -like '*Do not disturb on*') {
        Start-Process 'ms-settings:notifications'
        $opened = $true
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        $toggled = $false
        while ([DateTime]::UtcNow -lt $deadline -and -not $toggled) {
            $snapshot = [System.Collections.Generic.List[string]]::new()
            $root = [System.Windows.Automation.AutomationElement]::RootElement
            $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($window in $windows) {
                $process = Get-Process -Id $window.Current.ProcessId -ErrorAction SilentlyContinue
                if ($null -eq $process -or $process.ProcessName -notin @('SystemSettings', 'ApplicationFrameHost')) { continue }
                $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
                foreach ($element in $elements) {
                    $name = $element.Current.Name
                    $snapshot.Add("$($process.ProcessName) | $($element.Current.ClassName) | $name")
                    if ($name -notmatch '^Do not disturb(,? (On|Off))?$' -or $element.Current.IsOffscreen) { continue }
                    $toggle = $null
                    if (-not $element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) { continue }
                    if ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) { $toggle.Toggle() }
                    elseif ($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::Off) { throw 'Do not disturb toggle has indeterminate state' }
                    $toggled = $true
                    break
                }
                if ($toggled) { break }
            }
            Set-Content -Path (Join-Path $evidence 'notification-dnd-uia.txt') -Value ($snapshot -join "`n")
            Start-Sleep -Milliseconds 300
        }
        if (-not $toggled) { throw 'Do not disturb is on but its OS control was not found' }
        $settle = [DateTime]::UtcNow.AddSeconds(10)
        while ((Notification-Button).Current.Name -like '*Do not disturb on*' -and [DateTime]::UtcNow -lt $settle) { Start-Sleep -Milliseconds 200 }
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        foreach ($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
            $process = Get-Process -Id $window.Current.ProcessId -ErrorAction SilentlyContinue
            if ($null -ne $process -and $process.ProcessName -in @('SystemSettings', 'ApplicationFrameHost')) {
                $pattern = $null
                if ($window.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$pattern)) { $pattern.Close() }
            }
        }
    }
    $after = (Notification-Button).Current.Name
    @{before=$before; after=$after; changed=$opened; method='normal-os-ui'} | ConvertTo-Json | Set-Content (Join-Path $evidence 'notification-dnd.json')
    if ($after -like '*Do not disturb on*') { throw 'Do not disturb remained on after OS UI action' }
    Write-Output 'OS UI confirms Do not disturb is off; app notification permissions are unchanged'
    exit 0
}
$deadline = [DateTime]::UtcNow.AddSeconds(45)
while ([DateTime]::UtcNow -lt $deadline) {
    $snapshot = [System.Collections.Generic.List[string]]::new()
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($window in $windows) {
        $process = Get-Process -Id $window.Current.ProcessId -ErrorAction SilentlyContinue
        if ($null -eq $process) { continue }
        $snapshot.Add("Window: $($process.ProcessName) | $($window.Current.ClassName) | $($window.Current.Name)")
        if ($process.ProcessName -in @('ditero-desktop', 'msedge', 'chrome', 'pwsh', 'powershell')) { continue }
        $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($element in $elements) {
            $name = $element.Current.Name
            $snapshot.Add("$($element.Current.ClassName) | $($element.Current.AutomationId) | $name")
            if ($name -notlike '*Open Ditero to view your notification.*' -or $element.Current.IsOffscreen) { continue }
            $snapshot | Set-Content (Join-Path $evidence 'notification-popup-uia.txt')
            $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
            $bitmap = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
                $bitmap.Save((Join-Path $evidence 'notification-shown.png'))
            } finally { $graphics.Dispose(); $bitmap.Dispose() }
            if ($Mode -eq 'show') { Write-Output 'Observed actual Ditero toast'; exit 0 }
            $rectangle = $element.Current.BoundingRectangle
            if ($rectangle.Width -le 0 -or $rectangle.Height -le 0) { continue }
            Click-Element $element
            Write-Output 'Activated actual Ditero toast through OS UI'
            exit 0
        }
    }
    Set-Content -Path (Join-Path $evidence 'notification-last-uia.txt') -Value ($snapshot -join "`n")
    Start-Sleep -Milliseconds 200
}
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save((Join-Path $evidence 'notification-desktop-failure.png'))
} finally { $graphics.Dispose(); $bitmap.Dispose() }
throw 'No visible Ditero toast with the expected generic body'
