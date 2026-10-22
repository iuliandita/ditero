param([switch]$Worker, [string]$State = (Join-Path $env:RUNNER_TEMP 'desktop-journeys'))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$logFile = Join-Path $State 'evidence/session.log'
if ($Worker) {
    $code = 1
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        $elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        @{elevated=$elevated; method='restricted-normal-user-token'} | ConvertTo-Json | Set-Content (Join-Path $State 'evidence/session-privileges.json')
        if ($elevated) { throw 'Journey must run as a normal, unelevated desktop application' }
        & node --experimental-strip-types apps/desktop/tests/journeys/run.ts *> $logFile
        $code = $LASTEXITCODE
    } catch { $_ | Out-String | Add-Content $logFile }
    exit $code
}
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
public static class JourneyLimitedSession {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public int cb; public string reserved, desktop, title;
        public int x,y,width,height,xChars,yChars,fill,flags;
        public short show,reservedSize; public IntPtr reservedBytes,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public int pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct Label { public IntPtr sid; public uint attributes; }
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr input,uint flags,uint disabledCount,IntPtr disabled,uint privilegeCount,IntPtr privileges,uint restrictedCount,IntPtr restricted,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int kind,IntPtr information,int size);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,out int information,int size,out int length);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUser(IntPtr token,string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref Startup startup,out ProcessInfo process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static int Run(string executable,string arguments,string directory) {
        IntPtr input=IntPtr.Zero,token=IntPtr.Zero,job=IntPtr.Zero,label=IntPtr.Zero;
        ProcessInfo child=new ProcessInfo();
        try {
            Check(OpenProcessToken(GetCurrentProcess(),0xF01FF,out input));
            // LUA_TOKEN removes administrator groups; DISABLE_MAX_PRIVILEGE drops privileges.
            Check(CreateRestrictedToken(input,5,0,IntPtr.Zero,0,IntPtr.Zero,0,IntPtr.Zero,out token));
            var sid=new SecurityIdentifier("S-1-16-8192");
            var bytes=new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes,0);
            int header=Marshal.SizeOf<Label>(); label=Marshal.AllocHGlobal(header+bytes.Length);
            Marshal.Copy(bytes,0,IntPtr.Add(label,header),bytes.Length);
            Marshal.StructureToPtr(new Label {sid=IntPtr.Add(label,header),attributes=0x20},label,false);
            Check(SetTokenInformation(token,25,label,header+bytes.Length));
            int elevated,length; Check(GetTokenInformation(token,20,out elevated,4,out length));
            using (var identity=new WindowsIdentity(token)) {
                if (elevated!=0 || new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) throw new InvalidOperationException("Restricted token still elevated: elevation="+elevated+", administrator="+new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator));
            }
            job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
            var startup=new Startup {cb=Marshal.SizeOf<Startup>(),desktop="winsta0\\default"};
            var command=new StringBuilder("\""+executable+"\" "+arguments);
            Check(CreateProcessAsUser(token,executable,command,IntPtr.Zero,IntPtr.Zero,true,0x404,IntPtr.Zero,directory,ref startup,out child));
            Check(AssignProcessToJobObject(job,child.process));
            Check(ResumeThread(child.thread)!=uint.MaxValue);
            uint wait=WaitForSingleObject(child.process,840000);
            if (wait==258) throw new TimeoutException("Restricted desktop journey exceeded 14 minutes");
            Check(wait==0);
            uint code; Check(GetExitCodeProcess(child.process,out code)); return checked((int)code);
        } finally {
            if (job!=IntPtr.Zero) { TerminateJobObject(job,1); CloseHandle(job); }
            if (child.process!=IntPtr.Zero) { TerminateProcess(child.process,1); CloseHandle(child.process); }
            if (child.thread!=IntPtr.Zero) CloseHandle(child.thread);
            if (label!=IntPtr.Zero) Marshal.FreeHGlobal(label);
            if (token!=IntPtr.Zero) CloseHandle(token);
            if (input!=IntPtr.Zero) CloseHandle(input);
        }
    }
}
'@
$arguments = "-NoProfile -File `"$PSCommandPath`" -Worker -State `"$State`""
$code = [JourneyLimitedSession]::Run((Get-Command pwsh).Source, $arguments, (Get-Location).Path)
if (Test-Path $logFile) { Get-Content $logFile }
if ($code -ne 0) { throw "Restricted desktop journey exit $code" }
