param([ValidateSet('show', 'click')][string]$Mode = 'click')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class JourneyNotificationMouse {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
$evidence = Join-Path $env:RUNNER_TEMP 'desktop-journeys/evidence'
$deadline = [DateTime]::UtcNow.AddSeconds(45)
while ([DateTime]::UtcNow -lt $deadline) {
    $snapshot = [System.Collections.Generic.List[string]]::new()
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($window in $windows) {
        $process = Get-Process -Id $window.Current.ProcessId -ErrorAction SilentlyContinue
        if ($null -eq $process -or $process.ProcessName -notin @('ShellExperienceHost', 'ShellHost')) { continue }
        $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($element in $elements) {
            $name = $element.Current.Name
            $snapshot.Add("$($element.Current.ClassName) | $($element.Current.AutomationId) | $name")
            if ($name -notlike '*Open Ditero to view your notification.*') { continue }
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
            [void][JourneyNotificationMouse]::SetCursorPos([int]($rectangle.X + $rectangle.Width / 2), [int]($rectangle.Y + $rectangle.Height / 2))
            [JourneyNotificationMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
            [JourneyNotificationMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
            Write-Output 'Clicked measured Ditero toast bounds'
            exit 0
        }
    }
    $snapshot | Set-Content (Join-Path $evidence 'notification-last-uia.txt')
    Start-Sleep -Milliseconds 200
}
throw 'No visible Ditero toast with the expected generic body'
