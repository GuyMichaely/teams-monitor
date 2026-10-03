using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Per-run read-only profiles; no capabilities, loopback exemptions, services or machine-wide ACL changes.
// The parent owns this helper; this helper alone owns the restricted child job.
static class BunSandbox {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly object OutputLock = new object();
    static IntPtr Job;
    static int Stopping, Bytes;
    static int OutputLimit;
    static string Reason;
    static void Emit(object value) {
        try { lock (OutputLock) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); } }
        catch (IOException) { Stop("parent_closed"); }
    }
    static void Check(bool ok, string stage) { if (!ok) throw new BoundaryError(stage, Marshal.GetLastWin32Error()); }
    sealed class BoundaryError : Exception { public string Stage; public int Code; public BoundaryError(string stage, int code) { Stage = stage; Code = code; } }
    static void Stop(string reason) {
        if (Interlocked.CompareExchange(ref Stopping, 1, 0) != 0) return;
        Reason = reason;
        if (Job != IntPtr.Zero) TerminateJobObject(Job, 1);
    }
    static void SetJob<T>(int kind, T value) {
        int size = Marshal.SizeOf(value); IntPtr data = Marshal.AllocHGlobal(size);
        try { Marshal.StructureToPtr(value, data, false); Check(SetInformationJobObject(Job, kind, data, (uint)size), "job_limits"); }
        finally { Marshal.FreeHGlobal(data); }
    }
    static void Attribute<T>(IntPtr list, int attribute, T value, System.Collections.Generic.List<IntPtr> allocations) {
        int size = Marshal.SizeOf(value); IntPtr data = Marshal.AllocHGlobal(size); allocations.Add(data);
        Marshal.StructureToPtr(value, data, false);
        Check(UpdateProcThreadAttribute(list, 0, new IntPtr(attribute), data, new IntPtr(size), IntPtr.Zero, IntPtr.Zero), "process_attributes");
    }
    static void Protect(string path, SecurityIdentifier package, bool directory) {
        var user = WindowsIdentity.GetCurrent().User;
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var inherit = directory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None;
        var acl = directory ? (FileSystemSecurity)new DirectorySecurity() : new FileSecurity();
        acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        acl.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        acl.AddAccessRule(new FileSystemAccessRule(package, FileSystemRights.ReadAndExecute, inherit, PropagationFlags.None, AccessControlType.Allow));
        if (directory) Directory.SetAccessControl(path, (DirectorySecurity)acl); else File.SetAccessControl(path, (FileSecurity)acl);
    }
    static void NoReparse(string path) {
        for (var current = Path.GetFullPath(path); current != null; current = Path.GetDirectoryName(current))
            if ((Directory.Exists(current) || File.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new BoundaryError("reparse_path", 0);
    }
    static void Pipe(out IntPtr read, out IntPtr write, bool parentReads) {
        var sa = new SecurityAttributes { Size = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = true };
        Check(CreatePipe(out read, out write, ref sa, 0), "pipe");
        Check(SetHandleInformation(parentReads ? read : write, 1, 0), "pipe_inheritance");
    }
    static FileStream Stream(IntPtr handle, FileAccess access) { return new FileStream(new SafeFileHandle(handle, true), access, 4096, false); }
    static Thread Pump(FileStream stream, string kind) {
        var thread = new Thread(delegate() {
            try {
                byte[] buffer = new byte[4096]; int count;
                while ((count = stream.Read(buffer, 0, buffer.Length)) > 0) {
                    if (Interlocked.Add(ref Bytes, count) > OutputLimit) { Stop("output_limit"); break; }
                    Emit(new { kind = kind, data = Convert.ToBase64String(buffer, 0, count) });
                }
            } catch { Stop("pipe_error"); }
            finally { stream.Dispose(); }
        });
        thread.IsBackground = true; thread.Start(); return thread;
    }
    static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) { if (c == '\\') { slashes++; continue; } result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); result.Append(c); slashes = 0; }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static int Limit(string value, int min, int max) { int number; if (!int.TryParse(value, out number) || number < min || number > max) throw new BoundaryError("invalid_limit", 0); return number; }
    public static int Main(string[] args) {
        string run = null, moniker = null, profile = null;
        IntPtr sid = IntPtr.Zero, attrs = IntPtr.Zero, env = IntPtr.Zero, token = IntPtr.Zero;
        IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero, outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero, errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero;
        var allocations = new System.Collections.Generic.List<IntPtr>(); var pi = new ProcessInformation();
        bool initialized = false;
        try {
            if (args.Length != 8) throw new BoundaryError("arguments", 0);
            int timeout = Limit(args[3], 100, 30000), memory = Limit(args[4], 256, 2048), cpu = Limit(args[5], 1, 25), processes = Limit(args[6], 1, 8);
            OutputLimit = Limit(args[7], 4096, 262144);
            string root = Path.GetFullPath(args[0]); NoReparse(root); NoReparse(args[1]); NoReparse(args[2]); Directory.CreateDirectory(root);
            run = Path.Combine(root, "run-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(run);
            moniker = "tm.sandbox." + Guid.NewGuid().ToString("N");
            int hr = CreateAppContainerProfile(moniker, moniker, moniker, IntPtr.Zero, 0, out sid);
            if (hr != 0) throw new BoundaryError("package_sid", hr);
            var package = new SecurityIdentifier(sid);
            IntPtr profilePath;
            hr = GetAppContainerFolderPath(package.Value, out profilePath);
            if (hr != 0) throw new BoundaryError("profile_path", hr);
            try {
                profile = Marshal.PtrToStringUni(profilePath); NoReparse(profile);
                File.WriteAllText(Path.Combine(profile, "write-canary.txt"), "Read-only container profile.");
                foreach (string file in Directory.GetFiles(profile, "*", SearchOption.AllDirectories)) { NoReparse(file); Protect(file, package, false); }
                foreach (string dir in Directory.GetDirectories(profile, "*", SearchOption.AllDirectories)) { NoReparse(dir); Protect(dir, package, true); }
                Protect(profile, package, true);
            } finally { Marshal.FreeCoTaskMem(profilePath); }
            Protect(run, package, true);
            string exe = Path.Combine(run, "bun.exe"), worker = Path.Combine(run, "worker.mjs");
            File.Copy(args[1], exe); File.Copy(args[2], worker); Protect(exe, package, false); Protect(worker, package, false);
            string probe = Path.Combine(run, "app-packages-canary.txt"); File.WriteAllText(probe, "LPAC must not read this.");
            Protect(probe, new SecurityIdentifier("S-1-15-2-1"), false);
            Job = CreateJobObject(IntPtr.Zero, null); Check(Job != IntPtr.Zero, "create_job");
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000 | 0x200 | 0x100 | 0x8 | 0x20; // kill, aggregate/process memory, process count, priority
            limits.Basic.ActiveLimit = (uint)processes; limits.Basic.Priority = 0x4000; // BELOW_NORMAL
            limits.JobMemory = limits.ProcessMemory = new UIntPtr((ulong)memory * 1024 * 1024);
            SetJob(9, limits); SetJob(15, new CpuLimits { Flags = 1 | 4, Rate = (uint)cpu * 100 }); SetJob(4, (uint)0xff);
            Pipe(out inputRead, out inputWrite, false); Pipe(out outputRead, out outputWrite, true); Pipe(out errorRead, out errorWrite, true);
            IntPtr attrSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 4, 0, ref attrSize);
            attrs = Marshal.AllocHGlobal(attrSize); Check(InitializeProcThreadAttributeList(attrs, 4, 0, ref attrSize), "attribute_list"); initialized = true;
            Attribute(attrs, 0x20009, new SecurityCapabilities { Sid = sid }, allocations);
            Attribute(attrs, 0x2000f, (uint)1, allocations); // LPAC: opt out of ALL_APPLICATION_PACKAGES
            Attribute(attrs, 0x20007, (ulong)0x10000000, allocations); // no win32k system calls
            IntPtr handles = Marshal.AllocHGlobal(IntPtr.Size * 3); allocations.Add(handles);
            Marshal.Copy(new[] { inputRead, outputWrite, errorWrite }, 0, handles, 3);
            Check(UpdateProcThreadAttribute(attrs, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero), "handle_list");
            string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            // Never inherit secrets, user profile, proxy settings, NODE_OPTIONS or BUN_OPTIONS.
            env = Marshal.StringToHGlobalUni("APPDATA=" + run + "\0BUN_TELEMETRY_DISABLED=1\0LOCALAPPDATA=" + Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + "\0PATH=" + run + "\0SystemRoot=" + windows + "\0TEMP=" + run + "\0TM_SANDBOX_PROFILE=" + profile + "\0TMP=" + run + "\0USERPROFILE=" + run + "\0WINDIR=" + windows + "\0\0");
            var startup = new StartupInfoEx { Info = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfoEx)), Flags = 0x100, Input = inputRead, Output = outputWrite, Error = errorWrite }, Attributes = attrs };
            Check(CreateProcess(exe, new StringBuilder(Quote(exe) + " --no-env-file " + Quote(worker)), IntPtr.Zero, IntPtr.Zero, true,
                0x08000000 | 0x00080000 | 0x400 | 4, env, run, ref startup, out pi), "create_lpac");
            Check(AssignProcessToJobObject(Job, pi.Process), "assign_job");
            Check(OpenProcessToken(pi.Process, 8, out token), "token");
            int isContainer, returned;
            Check(GetTokenInformation(token, 29, out isContainer, 4, out returned) && isContainer == 1, "verify_container");
            // Class 46 is not a supported query on current Windows; LPAC is enforced by the creation attribute.
            // Verify the documented container SID and zero capabilities before guest execution.
            IntPtr tokenData = Marshal.AllocHGlobal(4096);
            try {
                Check(GetTokenInformationBuffer(token, 31, tokenData, 4096, out returned) && EqualSid(sid, Marshal.ReadIntPtr(tokenData)), "verify_sid");
                Check(GetTokenInformationBuffer(token, 30, tokenData, 4096, out returned) && Marshal.ReadInt32(tokenData) == 0, "verify_capabilities");
            } finally { Marshal.FreeHGlobal(tokenData); }
            Emit(new { kind = "ready", pid = pi.Pid, boundary = "windows_lpac", memoryMb = memory, cpuPercent = cpu, maxProcesses = processes });
            Check(ResumeThread(pi.Thread) != uint.MaxValue, "resume");
            CloseHandle(inputRead); inputRead = IntPtr.Zero; CloseHandle(outputWrite); outputWrite = IntPtr.Zero; CloseHandle(errorWrite); errorWrite = IntPtr.Zero;
            var input = Stream(inputWrite, FileAccess.Write); inputWrite = IntPtr.Zero;
            var outThread = Pump(Stream(outputRead, FileAccess.Read), "stdout"); outputRead = IntPtr.Zero;
            var errThread = Pump(Stream(errorRead, FileAccess.Read), "stderr"); errorRead = IntPtr.Zero;
            var inThread = new Thread(delegate() {
                try { var source = Console.OpenStandardInput(); var buffer = new byte[4096]; int count; while ((count = source.Read(buffer, 0, buffer.Length)) > 0) { input.Write(buffer, 0, count); input.Flush(); } Stop("parent_closed"); }
                catch { Stop("pipe_error"); } finally { input.Dispose(); }
            }); inThread.IsBackground = true; inThread.Start();
            if (WaitForSingleObject(pi.Process, (uint)timeout) != 0) Stop("timeout");
            uint code; Check(GetExitCodeProcess(pi.Process, out code), "exit_code");
            // Root exit isn't sufficient: terminate descendants before accepting completion.
            TerminateJobObject(Job, 1); outThread.Join(2000); errThread.Join(2000);
            Emit(new { kind = "exit", code = code, reason = Reason });
            return 0;
        } catch (BoundaryError error) { Emit(new { kind = "error", stage = error.Stage, win32 = error.Code }); return 1; }
        catch { Emit(new { kind = "error", stage = "native_failure", win32 = 0 }); return 1; }
        finally {
            if (Job != IntPtr.Zero) { TerminateJobObject(Job, 1); CloseHandle(Job); Job = IntPtr.Zero; }
            if (pi.Process != IntPtr.Zero) { TerminateProcess(pi.Process, 1); CloseHandle(pi.Process); }
            if (pi.Thread != IntPtr.Zero) CloseHandle(pi.Thread);
            foreach (IntPtr handle in new[] { token, inputRead, inputWrite, outputRead, outputWrite, errorRead, errorWrite }) if (handle != IntPtr.Zero) CloseHandle(handle);
            if (initialized) DeleteProcThreadAttributeList(attrs); if (attrs != IntPtr.Zero) Marshal.FreeHGlobal(attrs);
            foreach (var allocation in allocations) Marshal.FreeHGlobal(allocation);
            if (env != IntPtr.Zero) Marshal.FreeHGlobal(env); if (sid != IntPtr.Zero) FreeSid(sid);
            if (moniker != null && DeleteAppContainerProfile(moniker) != 0) Emit(new { kind = "cleanup_warning", resource = "profile" });
            if (run != null) {
                // Image mapping/AV handles can outlast process exit briefly.
                bool removed = false;
                for (int attempt = 0; attempt < 20; attempt++) {
                    try { NoReparse(run); Directory.Delete(run, true); removed = true; break; }
                    catch (IOException) { Thread.Sleep(100); }
                    catch { break; }
                }
                if (!removed) Emit(new { kind = "cleanup_warning", resource = "bundle" });
            }
        }
    }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Size; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityCapabilities { public IntPtr Sid, Capabilities; public uint Count, Reserved; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] struct CpuLimits { public uint Flags, Rate; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo { public int Size; public string Reserved, Desktop, Title; public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags; public short ShowWindow, ReservedSize; public IntPtr ReservedData, Input, Output, Error; }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr Process, Thread; public uint Pid, Tid; }
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr caps, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int GetAppContainerFolderPath(string sid, out IntPtr path);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int size, out int returned);
    [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", SetLastError = true)] static extern bool GetTokenInformationBuffer(IntPtr token, int kind, IntPtr value, int size, out int returned);
    [DllImport("advapi32.dll")] static extern bool EqualSid(IntPtr a, IntPtr b);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes sa, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string exe, StringBuilder command, IntPtr processSa, IntPtr threadSa, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfoEx startup, out ProcessInformation pi);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
}
