Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$state = Join-Path $env:RUNNER_TEMP 'desktop-journeys'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class JourneySessionToken {
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,out int information,int size,out int length);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static bool Elevated() {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(),8,out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            int elevated,length;
            if (!GetTokenInformation(token,20,out elevated,4,out length)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return elevated!=0;
        } finally { CloseHandle(token); }
    }
}
'@
@{
    elevated=[JourneySessionToken]::Elevated()
    administrator=$administrator
    method='inherited-runner-token'
    scope='core journeys only; notification display/click unqualified on hosted runner'
} | ConvertTo-Json | Set-Content (Join-Path $state 'evidence/session-privileges.json')
& node --experimental-strip-types apps/desktop/tests/journeys/run.ts
if ($LASTEXITCODE -ne 0) { throw "Desktop journey exit $LASTEXITCODE" }
