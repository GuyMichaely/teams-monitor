using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("TM")]
[assembly: System.Reflection.AssemblyProduct("TM")]

namespace TeamsMonitorDesktop {
    // A handle-owned process tree, never reconstructed from a persisted PID.
    public sealed class OwnedJob : IDisposable {
        IntPtr handle;
        public OwnedJob() {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new Win32Exception();
            var limits = new ExtendedLimits();
            limits.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE; children cannot break away.
            int size = Marshal.SizeOf(limits);
            IntPtr data = Marshal.AllocHGlobal(size);
            try {
                Marshal.StructureToPtr(limits, data, false);
                if (!SetInformationJobObject(handle, 9, data, (uint)size)) throw new Win32Exception();
            } catch { Dispose(); throw; }
            finally { Marshal.FreeHGlobal(data); }
        }
        public static string Quote(string value) {
            var result = new StringBuilder("\""); int slashes = 0;
            foreach (char c in value) {
                if (c == '\\') { slashes++; continue; }
                result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
                result.Append(c); slashes = 0;
            }
            return result.Append('\\', slashes * 2).Append('"').ToString();
        }
        public Process Start(string exe, string arguments, string cwd, string stdout, string stderr) {
            var security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = true };
            IntPtr output = IntPtr.Zero, error = IntPtr.Zero, input = IntPtr.Zero;
            var info = new ProcessInformation();
            try {
                output = CreateFile(stdout, 4, 3, ref security, 4, 0x80, IntPtr.Zero); // append, OPEN_ALWAYS
                error = CreateFile(stderr, 4, 3, ref security, 4, 0x80, IntPtr.Zero);
                input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0x80, IntPtr.Zero);
                if (output == new IntPtr(-1) || error == new IntPtr(-1) || input == new IntPtr(-1)) throw new Win32Exception();
                var startup = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfo)), Flags = 0x101,
                    Input = input, Output = output, Error = error, ShowWindow = 0 };
                // Suspend before assigning, so even the first GUI child inherits the owned job.
                if (!CreateProcess(exe, new StringBuilder(Quote(exe) + " " + arguments), IntPtr.Zero, IntPtr.Zero,
                    true, 0x08000004, IntPtr.Zero, cwd, ref startup, out info)) throw new Win32Exception();
                if (!AssignProcessToJobObject(handle, info.Process)) throw new Win32Exception();
                if (ResumeThread(info.Thread) == uint.MaxValue) throw new Win32Exception();
                return Process.GetProcessById((int)info.Pid);
            } catch {
                if (info.Process != IntPtr.Zero) TerminateProcess(info.Process, 1);
                throw;
            } finally {
                if (info.Process != IntPtr.Zero) CloseHandle(info.Process);
                if (info.Thread != IntPtr.Zero) CloseHandle(info.Thread);
                foreach (IntPtr file in new[] { output, error, input }) if (file != IntPtr.Zero && file != new IntPtr(-1)) CloseHandle(file);
            }
        }
        public void Attach(Process process) {
            if (!AssignProcessToJobObject(handle, process.Handle)) throw new Win32Exception();
        }
        public bool Contains(Process process) { bool found; return IsProcessInJob(process.Handle, handle, out found) && found; }
        public static bool InAnyJob() { bool found; return IsProcessInJob(Process.GetCurrentProcess().Handle, IntPtr.Zero, out found) && found; }
        public static uint ParentPid() {
            IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
            if (snapshot == new IntPtr(-1)) return 0;
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            try {
                if (Process32First(snapshot, ref entry)) do {
                    if (entry.Pid == Process.GetCurrentProcess().Id) return entry.ParentPid;
                } while (Process32Next(snapshot, ref entry));
                return 0;
            } finally { CloseHandle(snapshot); }
        }
        public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }

        [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
        [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long ProcessTime, JobTime; public uint LimitFlags; public UIntPtr MinWorking, MaxWorking; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling; }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo { public int Size; public string Reserved, Desktop, Title; public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags; public short ShowWindow, ReservedSize; public IntPtr ReservedData, Input, Output, Error; }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr Process, Thread; public uint Pid, Tid; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)] struct ProcessEntry {
            public uint Size, Usage, Pid; public IntPtr Heap; public uint Module, Threads, ParentPid; public int Priority; public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Exe;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string path, uint access, uint share, ref SecurityAttributes security, uint mode, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string exe, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInformation info);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    }

    // Execution requests belong to a thread; acquire and clear on the WinForms UI thread.
    sealed class KeepAwake : IDisposable {
        const uint Continuous = 0x80000000, SystemRequired = 0x1, DisplayRequired = 0x2;
        readonly Func<uint, uint> request;
        readonly int ownerThread = Thread.CurrentThread.ManagedThreadId;
        public bool Active { get; private set; }
        public bool Failed { get; private set; }
        public KeepAwake() : this(SetThreadExecutionState) { }
        internal KeepAwake(Func<uint, uint> nativeRequest) { request = nativeRequest; }
        public bool SetActive(bool active) {
            if (Thread.CurrentThread.ManagedThreadId != ownerThread) throw new InvalidOperationException("KEEP_AWAKE_WRONG_THREAD");
            if (Active == active && !Failed) return true;
            if (request(Continuous | (active ? SystemRequired | DisplayRequired : 0)) == 0) {
                Failed = true; return false;
            }
            Active = active; Failed = false; return true;
        }
        public void Dispose() { SetActive(false); }
        [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
    }

    public class TrayWindow : Form {
        public bool Quitting;
        protected override void OnFormClosing(FormClosingEventArgs e) {
            if (!Quitting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); }
            base.OnFormClosing(e);
        }
    }

    // A local save signal, not a timer or file watcher. No event is created by the sender.
    sealed class AwakeSignal : IDisposable {
        readonly EventWaitHandle changed;
        readonly RegisteredWaitHandle registration;
        public AwakeSignal(string root, Action handler) {
            changed = new EventWaitHandle(false, EventResetMode.AutoReset, Program.InstanceName(root) + "_awake_changed");
            registration = ThreadPool.RegisterWaitForSingleObject(changed, delegate(object state, bool timedOut) { handler(); }, null, Timeout.Infinite, false);
        }
        public static int Send(string root) {
            try {
                EventWaitHandle existing;
                if (!EventWaitHandle.TryOpenExisting(Program.InstanceName(root) + "_awake_changed", out existing)) return 2;
                using (existing) { existing.Set(); }
                return 0;
            } catch { return 3; }
        }
        public void Dispose() { registration.Unregister(null); changed.Dispose(); }
    }

    // Checkout/session-scoped IPC. Only the current Windows user can connect;
    // network logons are denied. No TCP listener or arbitrary command execution.
    sealed class TrayCommands : IDisposable {
        readonly object sync = new object();
        readonly HashSet<NamedPipeServerStream> pipes = new HashSet<NamedPipeServerStream>();
        readonly Func<string, Task<string>> dispatch;
        readonly Action<string> completed;
        readonly string name;
        bool disposed;
        public static string Name(string root) {
            return Program.InstanceName(root).Substring(6) + "_" + Process.GetCurrentProcess().SessionId + "_control";
        }
        public TrayCommands(string root, Func<string, Task<string>> handler, Action<string> afterResponse) {
            name = Name(root); dispatch = handler; completed = afterResponse;
            for (int i = 0; i < 4; i++) Listen();
        }
        async void Listen() {
            while (true) {
                NamedPipeServerStream pipe;
                string completedAction = null;
                lock (sync) {
                    if (disposed) return;
                    var security = new PipeSecurity(); security.SetAccessRuleProtection(true, false);
                    security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
                    security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
                    pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 4, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 256, 4096, security);
                    pipes.Add(pipe);
                }
                try {
                    await Task.Factory.FromAsync(pipe.BeginWaitForConnection, pipe.EndWaitForConnection, null).ConfigureAwait(false);
                    // Commands are small ASCII lines; reject oversized/idle clients.
                    var input = new StringBuilder(); var one = new byte[1];
                    var deadline = Task.Delay(5000);
                    while (input.Length <= 16) {
                        var read = pipe.ReadAsync(one, 0, 1);
                        if (await Task.WhenAny(read, deadline).ConfigureAwait(false) != read) throw new TimeoutException();
                        if (await read.ConfigureAwait(false) == 0) throw new IOException();
                        if (one[0] == 10) break;
                        input.Append((char)one[0]);
                    }
                    if (input.Length > 16) throw new IOException();
                    string response = await dispatch(input.ToString()).ConfigureAwait(false);
                    completedAction = input.ToString();
                    byte[] output = Encoding.UTF8.GetBytes(response + "\n");
                    var writing = pipe.WriteAsync(output, 0, output.Length);
                    if (await Task.WhenAny(writing, Task.Delay(5000)).ConfigureAwait(false) != writing) throw new TimeoutException();
                    await writing.ConfigureAwait(false);
                } catch (IOException) { } catch (ObjectDisposedException) { } catch (TimeoutException) { }
                finally { lock (sync) { pipes.Remove(pipe); pipe.Dispose(); } }
                if (completedAction != null) completed(completedAction);
            }
        }
        public void Dispose() {
            lock (sync) { disposed = true; foreach (var pipe in pipes) pipe.Dispose(); pipes.Clear(); }
        }
    }

    sealed class TrayApplication : IDisposable {
        readonly string root, bun, logs, session;
        OwnedJob job = new OwnedJob();
        readonly EventWaitHandle show;
        readonly NotifyIcon tray;
        readonly TrayWindow window = new TrayWindow();
        readonly Label status = new Label();
        readonly Label awakeStatus = new Label();
        readonly KeepAwake keepAwake = new KeepAwake();
        readonly Button start = new Button();
        readonly Button stop = new Button();
        readonly Button quit = new Button();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly AwakeSignal awakeSignal;
        readonly TrayCommands commands;
        readonly SemaphoreSlim commandGate = new SemaphoreSlim(1, 1);
        int commandCount;
        string startError;
        Process supervisor;
        bool busy, quitting, quitPending, disposed, systemStopped, awakePolicyPending, stackHealthy, keepAwakeEnabled = true;
        Task awakePolicyTask;
        CancellationTokenSource startup;
        // Self-test injection only; the installed app always uses real local control/processes.
        Func<string, int, CancellationToken, Task<Dictionary<string, object>>> testControl;
        Func<OwnedJob, Process> testSupervisor;
        int observedExitPid;
        string dashboard = "http://127.0.0.1:8090/";
        public TrayApplication(string project, string runtime, EventWaitHandle showEvent, bool agentic = false) {
            root = project; bun = runtime; show = showEvent;
            logs = Path.Combine(root, "data", "desktop"); Directory.CreateDirectory(logs);
            session = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff");
            Log("started pid=" + Process.GetCurrentProcess().Id + " parentPid=" + OwnedJob.ParentPid() + " inheritedJob=" + OwnedJob.InAnyJob());
            window.Text = agentic ? "TM — Agentic" : "TM"; window.Size = new Size(480, 340); window.MinimumSize = new Size(480, 340);
            window.StartPosition = FormStartPosition.CenterScreen; window.BackColor = Color.FromArgb(24, 27, 32);
            window.ForeColor = Color.WhiteSmoke; window.Font = new Font("Segoe UI", 10);
            window.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            status.SetBounds(20, 18, 420, 108); status.Text = "Starting system…";
            status.AutoSize = false; window.Controls.Add(status);
            awakeStatus.SetBounds(20, 128, 420, 20); awakeStatus.Font = new Font("Segoe UI", 9);
            awakeStatus.Text = "Keep awake: Off"; window.Controls.Add(awakeStatus);
            AddButton("Open dashboard", 20, 150, delegate { Open(dashboard); });
            AddButton("Open logs", 235, 150, delegate { Open(Path.Combine(root, "data")); });
            start.Text = "Start system"; StyleButton(start); start.SetBounds(20, 195, 200, 34); start.Click += async delegate { await Start(); }; window.Controls.Add(start);
            stop.Text = "Stop system"; StyleButton(stop); stop.SetBounds(235, 195, 200, 34); stop.Click += async delegate { if (startup != null) CancelStartup(); else await Stop(); }; window.Controls.Add(stop);
            quit.Text = "Quit TM"; StyleButton(quit); quit.SetBounds(235, 240, 200, 34); quit.Click += async delegate { await Quit(); }; window.Controls.Add(quit);
            var menu = new ContextMenuStrip();
            menu.Items.Add(agentic ? "Show Agentic status" : "Show status", null, delegate { Show(); });
            menu.Items.Add("Open dashboard", null, delegate { Open(dashboard); });
            menu.Items.Add("Open logs", null, delegate { Open(Path.Combine(root, "data")); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit TM", null, async delegate { await Quit(); });
            tray = new NotifyIcon { Icon = window.Icon, Text = window.Text + " — starting", ContextMenuStrip = menu, Visible = true };
            tray.MouseClick += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) Show(); };
            // Force the handle now so save notifications can always marshal to its UI thread.
            var windowHandle = window.Handle;
            commands = new TrayCommands(root, DispatchCommand, delegate(string action) {
                if (action != "quit") return;
                try { window.BeginInvoke(new Action(async delegate { await Quit(); })); }
                catch (InvalidOperationException) { }
            });
            awakeSignal = new AwakeSignal(root, delegate {
                try {
                    window.BeginInvoke(new Action(async delegate {
                        if (quitting || disposed) return;
                        Log("keep_awake_save_signal");
                        try { await ReadAwakePolicy(); }
                        catch { awakeStatus.Text = "Keep awake: Setting update failed — save again"; }
                    }));
                } catch (InvalidOperationException) { }
            });
            timer.Interval = 5000; timer.Tick += async delegate {
                if (show.WaitOne(0)) Show();
                if (!busy && !quitting && !quitPending && commandCount == 0) await Refresh();
            }; timer.Start();
            window.Shown += async delegate { await Start(); };
            window.FormClosing += delegate(object sender, FormClosingEventArgs e) {
                if (e.CloseReason != CloseReason.UserClosing) { Log("windows_session_ending"); SetAwake(false); job.Dispose(); }
            };
        }
        Button AddButton(string label, int x, int y, EventHandler action) {
            var button = new Button { Text = label }; StyleButton(button); button.SetBounds(x, y, 200, 34); button.Click += action; window.Controls.Add(button);
            return button;
        }
        static void StyleButton(Button button) {
            // Own both colors; themed rendering can otherwise mix dark fill with black text.
            button.FlatStyle = FlatStyle.Flat;
            button.UseVisualStyleBackColor = false;
            button.BackColor = SystemInformation.HighContrast ? SystemColors.Control : Color.FromArgb(48, 54, 64);
            button.ForeColor = SystemInformation.HighContrast ? SystemColors.ControlText : Color.WhiteSmoke;
            button.FlatAppearance.BorderColor = SystemInformation.HighContrast ? SystemColors.ControlText : Color.FromArgb(113, 124, 140);
            button.FlatAppearance.MouseOverBackColor = SystemInformation.HighContrast ? SystemColors.Control : Color.FromArgb(65, 74, 87);
            button.FlatAppearance.MouseDownBackColor = SystemInformation.HighContrast ? SystemColors.Control : Color.FromArgb(79, 90, 106);
        }
        void Open(string target) { try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); } catch { status.Text = "Could not open " + (target == dashboard ? "dashboard." : "logs."); } }
        public void Show() { window.Show(); window.WindowState = FormWindowState.Normal; window.Activate(); }
        Task<string> DispatchCommand(string action) {
            var result = new TaskCompletionSource<string>();
            try {
                window.BeginInvoke(new Action(async delegate {
                    try { result.SetResult(await Command(action)); }
                    catch { result.SetResult(new JavaScriptSerializer().Serialize(new { ok = false, error = "TRAY_CONTROL_FAILED" })); }
                }));
            } catch (InvalidOperationException) { result.SetResult("{\"ok\":false,\"error\":\"TRAY_UNAVAILABLE\"}"); }
            return result.Task;
        }
        string CommandStatus(bool ok = true, string error = null) {
            bool alive = supervisor != null && !supervisor.HasExited;
            return new JavaScriptSerializer().Serialize(new {
                ok = ok, error = error, trayPid = Process.GetCurrentProcess().Id,
                state = quitting || quitPending ? "quitting" : busy ? (startup != null ? "starting" : "busy") : systemStopped ? "stopped" : alive && startError == null && stackHealthy ? "running" : "needs_attention",
                status = status.Text, supervisorPid = alive ? (int?)supervisor.Id : null
            });
        }
        async Task<string> Command(string action) {
            if (action != "start" && action != "stop" && action != "restart" && action != "status" && action != "quit") return CommandStatus(false, "INVALID_COMMAND");
            if (quitting || quitPending || disposed) return CommandStatus(false, "TRAY_UNAVAILABLE");
            if (action == "status") return CommandStatus();
            // Stop/restart can cancel startup even while another command is awaiting it.
            if (action == "stop" || action == "restart" || action == "quit") CancelStartup();
            commandCount++;
            await commandGate.WaitAsync();
            try {
                while (busy && !quitting) await Task.Delay(50);
                if (quitting || quitPending || disposed) return CommandStatus(false, "TRAY_UNAVAILABLE");
                Log("local_command action=" + action);
                if (action == "quit") quitPending = true;
                if (action == "stop" || action == "restart" || action == "quit") await Stop();
                if (action == "start" || action == "restart") await Start();
                if ((action == "start" || action == "restart") && startError != null) return CommandStatus(false, startError);
                if (!systemStopped) {
                    // Component-start API acknowledges launch before the monitor
                    // publishes readiness. Do not report successful startup early.
                    var readiness = Stopwatch.StartNew();
                    do {
                        await Refresh();
                        if (stackHealthy || supervisor == null || supervisor.HasExited) break;
                        await Task.Delay(500);
                    } while (readiness.ElapsedMilliseconds < 20000 && !quitting);
                }
                bool success = action == "stop" || action == "quit" ? supervisor == null : stackHealthy && supervisor != null && !supervisor.HasExited && !systemStopped;
                return CommandStatus(success, success ? null : "STACK_NOT_READY");
            } finally { commandGate.Release(); commandCount--; }
        }
        void SetAwake(bool active) {
            active = active && !quitting && !disposed && !systemStopped;
            bool wasActive = keepAwake.Active, wasFailed = keepAwake.Failed;
            bool success = keepAwake.SetActive(active);
            awakeStatus.Text = success ? (active ? "Keep awake: Active (display and system)" : "Keep awake: Off") : "Keep awake: Failed — check logs";
            if (wasActive != keepAwake.Active || wasFailed != keepAwake.Failed)
                Log(success ? "keep_awake_" + (active ? "enabled" : "released") : "keep_awake_request_failed requested=" + active);
        }
        void Log(string message) {
            try {
                string path = Path.Combine(logs, "tray.log");
                if (File.Exists(path) && new FileInfo(path).Length > 262144) {
                    string old = path + ".1"; if (File.Exists(old)) File.Delete(old); File.Move(path, old);
                }
                File.AppendAllText(path, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine);
            } catch { }
        }
        Task ReadAwakePolicy() {
            awakePolicyPending = true;
            if (awakePolicyTask == null || awakePolicyTask.IsCompleted) awakePolicyTask = ReadAwakePolicyLoop();
            return awakePolicyTask;
        }
        async Task ReadAwakePolicyLoop() {
            // Coalesce saves, but reread if another signal arrives during the config read.
            while (awakePolicyPending && !quitting && !disposed) {
                awakePolicyPending = false;
                try {
                    var policy = await Control("awake-policy");
                    if (quitting || disposed) return;
                    if (awakePolicyPending) continue;
                    keepAwakeEnabled = Convert.ToBoolean(policy["enabled"]);
                    SetAwake(keepAwakeEnabled && supervisor != null && !supervisor.HasExited);
                } catch { Log("keep_awake_policy_read_failed save_again_required"); throw; }
            }
        }
        async Task<Dictionary<string, object>> Control(string action, int ownerPid = 0, CancellationToken cancellation = default(CancellationToken)) {
            if (testControl != null) return await testControl(action, ownerPid, cancellation);
            return await Task.Run(() => {
                cancellation.ThrowIfCancellationRequested();
                using (var process = new Process()) {
                    process.StartInfo = new ProcessStartInfo(bun, "--env-file=.env " + OwnedJob.Quote(Path.Combine(root, "scripts", "tray-control.mjs")) + " " + action + (ownerPid > 0 ? " " + ownerPid : "")) {
                        WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
                    };
                    process.Start();
                    try { job.Attach(process); } catch { if (!process.HasExited) process.Kill(); throw; }
                    // Kill only this handle-owned helper. Start unwinds before closing its job.
                    using (cancellation.Register(delegate { try { if (!process.HasExited) process.Kill(); } catch (InvalidOperationException) { } catch (Win32Exception) { } })) {
                    var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(25000)) { process.Kill(); throw new TimeoutException(); }
                    Task.WaitAll(output, error);
                    cancellation.ThrowIfCancellationRequested();
                    var result = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(output.Result);
                    if (process.ExitCode != 0 || result.ContainsKey("error")) throw new InvalidOperationException(result.ContainsKey("error") ? Convert.ToString(result["error"]) : "LOCAL_CONTROL_FAILED");
                    return result;
                    }
                }
            });
        }
        async Task Start() {
            if (busy || quitting || quitPending) return;
            startError = null;
            startup = new CancellationTokenSource(); var cancellation = startup.Token;
            busy = true; start.Enabled = false; stop.Text = "Cancel startup"; stop.Enabled = true; systemStopped = false; status.Text = "Starting system…";
            Exception startupError = null;
            try {
                try {
                var policy = await Control("awake-policy", 0, cancellation);
                cancellation.ThrowIfCancellationRequested(); keepAwakeEnabled = Convert.ToBoolean(policy["enabled"]);
                SetAwake(keepAwakeEnabled);
                if (supervisor != null && !supervisor.HasExited) {
                    await Control("resume-components", 0, cancellation); cancellation.ThrowIfCancellationRequested(); Log("components_resumed"); return;
                }
                if (supervisor != null) {
                    Log("replacing_owned_tree supervisorExit=" + supervisor.ExitCode);
                    job.Dispose(); job = new OwnedJob(); supervisor.Dispose(); supervisor = null;
                }
                var description = await Control("describe", 0, cancellation); cancellation.ThrowIfCancellationRequested(); dashboard = Convert.ToString(description["url"]);
                await Control("prepare", 0, cancellation);
                cancellation.ThrowIfCancellationRequested();
                supervisor = testSupervisor != null ? testSupervisor(job) : job.Start(bun, "--env-file=.env scripts/gui-supervisor.mjs start", root,
                    Path.Combine(logs, "supervisor-" + session + ".out.log"), Path.Combine(logs, "supervisor-" + session + ".err.log"));
                Log("supervisor_started pid=" + supervisor.Id);
                bool ready = false;
                for (int attempt = 0; attempt < 30; attempt++) {
                    cancellation.ThrowIfCancellationRequested();
                    if (supervisor.HasExited) throw new InvalidOperationException("SUPERVISOR_EXITED");
                    try { var health = await Control("status", 0, cancellation); ready = Convert.ToString(health["gui"]) == "Running"; } catch (OperationCanceledException) { throw; } catch { }
                    cancellation.ThrowIfCancellationRequested();
                    if (ready) break;
                    await Task.Delay(500, cancellation);
                }
                if (!ready) throw new TimeoutException();
                cancellation.ThrowIfCancellationRequested();
                await Control("start-components", 0, cancellation);
                cancellation.ThrowIfCancellationRequested();
                Log("components_started");
                status.Text = "System started.";
                tray.Text = window.Text + " — running";
                tray.ShowBalloonTip(4000, window.Text, "Running.", ToolTipIcon.Info);
                } catch (Exception error) { startupError = error; }
                if (startupError != null) {
                var error = startupError;
                if (cancellation.IsCancellationRequested) {
                    startError = "STARTUP_CANCELLED";
                    systemStopped = true;
                    try { await StopOwnedTree(); }
                    catch (Exception cleanupError) { Log("startup_cancel_cleanup_failed type=" + cleanupError.GetType().Name); }
                    Log("startup_cancelled");
                    status.Text = quitting ? "Stopping system…" : "Startup cancelled.\nClick Start system to start it again.";
                    tray.Text = window.Text + (quitting ? " — stopping" : " — stopped");
                    return;
                }
                string code = error is InvalidOperationException ? error.Message : error.GetType().Name;
                startError = code;
                Log("startup_failed code=" + code);
                status.Text = code == "EXISTING_GUI" ? "Another TM system is running.\nQuit its tray app before starting this version." :
                    code == "EXISTING_SUPERVISOR" ? "A GUI supervisor is already running.\nStop it with bun run gui:stop, then click Start system." :
                    code == "EXISTING_MONITOR" ? "An external monitor is already running.\nStop it from its terminal or dashboard before starting here." :
                    "System needs attention.\nOpen logs for details; the tray remains available.\nIf the GUI started, use Open dashboard for controls.";
                tray.Text = window.Text + " — needs attention";
                }
            } finally {
                startup.Dispose(); startup = null;
                SetAwake(keepAwakeEnabled && supervisor != null && !supervisor.HasExited);
                busy = false; start.Enabled = !quitting; stop.Text = "Stop system"; stop.Enabled = !quitting && supervisor != null;
            }
        }
        void CancelStartup() {
            if (startup == null || startup.IsCancellationRequested) return;
            systemStopped = true; stop.Enabled = false; SetAwake(false);
            status.Text = "Cancelling startup…"; tray.Text = window.Text + " — stopping"; Log("startup_cancel_requested");
            startup.Cancel();
        }
        async Task StopOwnedTree() {
            SetAwake(false);
            try {
            if (supervisor != null) {
                try { await Control("stop-owned", supervisor.Id); } catch { Log("api_stop_unavailable owned_tree_will_stop"); }
                await Task.Run(() => supervisor.WaitForExit(5000));
            }
            if (awakePolicyTask != null) try { await awakePolicyTask; } catch { }
            } finally {
            job.Dispose();
            if (supervisor != null) { supervisor.Dispose(); supervisor = null; }
            if (!quitting) job = new OwnedJob();
            Log("owned_process_tree_stopped");
            }
        }
        async Task Stop() {
            if (busy || quitting) return;
            busy = true; systemStopped = true; start.Enabled = false; stop.Enabled = false;
            status.Text = "Stopping system…"; tray.Text = window.Text + " — stopping"; Log("system_stop_requested");
            try {
                await StopOwnedTree(); systemStopped = true;
                status.Text = "System stopped.\nClick Start system to start it again.";
                tray.Text = window.Text + " — stopped";
            } catch (Exception error) {
                Log("system_stop_failed type=" + error.GetType().Name);
                status.Text = "Could not finish stopping.\nOpen logs for details, or quit using the tray icon.";
                tray.Text = window.Text + " — needs attention";
            } finally { busy = false; start.Enabled = true; stop.Enabled = supervisor != null; }
        }
        async Task Refresh() {
            busy = true;
            stackHealthy = false;
            try {
                if (supervisor == null || supervisor.HasExited) {
                    SetAwake(false);
                    if (systemStopped) {
                        status.Text = "System stopped.\nClick Start system to start it again.";
                        tray.Text = window.Text + " — stopped"; return;
                    }
                    if (supervisor != null && observedExitPid != supervisor.Id) {
                        observedExitPid = supervisor.Id;
                        Log("supervisor_exited pid=" + supervisor.Id + " exit=" + supervisor.ExitCode + " hex=0x" + ((uint)supervisor.ExitCode).ToString("X8"));
                    }
                    status.Text = "GUI supervisor stopped.\nClick Start system to start it.\nOpen logs for shutdown evidence.";
                    tray.Text = window.Text + " — supervisor stopped"; return;
                }
                var value = await Control("status");
                status.Text = "GUI supervisor: " + value["gui"] + "\nMonitor: " + value["monitor"] + "\nTunnel: " + value["tunnel"];
                bool healthy = Convert.ToString(value["gui"]) == "Running" && Convert.ToString(value["monitor"]) == "Running" && Convert.ToString(value["tunnel"]) == "Running";
                stackHealthy = healthy;
                tray.Text = window.Text + (healthy ? " — running" : " — needs attention");
            } catch { status.Text = "GUI is not responding.\nThe supervisor may be recovering it.\nOpen logs for details."; tray.Text = window.Text + " — GUI unavailable"; }
            finally { busy = false; }
        }
        async Task Quit() {
            if (quitting) return; quitting = true; timer.Stop(); quit.Enabled = false;
            CancelStartup(); start.Enabled = false; stop.Enabled = false;
            SetAwake(false);
            Log("quit_requested"); status.Text = "Stopping system…"; tray.Text = window.Text + " — stopping";
            // Let an in-progress start/status operation finish before disposing its job.
            while (busy) await Task.Delay(100);
            await StopOwnedTree();
            tray.Visible = false; window.Quitting = true; window.Close(); Application.ExitThread();
        }
        public void Run() { Application.Run(window); }
        public void Dispose() { disposed = true; commands.Dispose(); awakeSignal.Dispose(); keepAwake.Dispose(); timer.Dispose(); tray.Dispose(); job.Dispose(); if (supervisor != null) supervisor.Dispose(); window.Dispose(); }
        internal static void TestStartupCancellation(string home) {
            string runtime = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".bun", "bin", "bun.exe");
            foreach (string phase in new[] { "prepare", "status", "start-components", "quit" }) {
                using (var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset))
                using (var app = new TrayApplication(home, runtime, showEvent)) {
                    app.timer.Stop(); bool entered = false; Process child = null;
                    app.testControl = async delegate(string action, int pid, CancellationToken token) {
                        if (action == (phase == "quit" ? "start-components" : phase)) {
                            entered = true; await Task.Delay(Timeout.Infinite, token);
                        }
                        return new Dictionary<string, object> { { "enabled", false }, { "url", "http://127.0.0.1:1" }, { "gui", "Running" } };
                    };
                    app.testSupervisor = delegate(OwnedJob job) {
                        var owned = job.Start(runtime, "--no-env-file -e " + OwnedJob.Quote("setInterval(()=>{},1000)"), home,
                            Path.Combine(home, phase + ".out"), Path.Combine(home, phase + ".err"));
                        child = Process.GetProcessById(owned.Id); return owned;
                    };
                    var starting = app.Start();
                    PumpUntil(delegate { return entered; }, "Startup did not reach test phase.");
                    if (!app.stop.Enabled || app.stop.Text != "Cancel startup") throw new Exception("Startup must expose Cancel startup.");
                    Task closing = null;
                    if (phase == "quit") closing = app.Quit(); else app.CancelStartup();
                    PumpUntil(delegate { return starting.IsCompleted && (closing == null || closing.IsCompleted); }, "Cancellation did not finish promptly.");
                    starting.GetAwaiter().GetResult(); if (closing != null) closing.GetAwaiter().GetResult();
                    if (app.startup != null || app.supervisor != null || app.keepAwake.Active || !app.systemStopped || app.busy) throw new Exception("Cancelled startup left active state.");
                    if (child != null) { if (!child.WaitForExit(2000)) throw new Exception("Cancelled startup left an owned process alive."); child.Dispose(); }
                    if (phase == "quit") { if (!app.window.IsDisposed || app.tray.Visible) throw new Exception("Quit during startup must close window/tray."); }
                    else {
                        if (app.window.IsDisposed || !app.start.Enabled || app.stop.Enabled || !app.status.Text.StartsWith("Startup cancelled.")) throw new Exception("Cancel must leave restartable UI.");
                        app.testControl = delegate(string action, int pid, CancellationToken token) {
                            return Task.FromResult(new Dictionary<string, object> { { "enabled", false }, { "url", "http://127.0.0.1:1" }, { "gui", "Running" } });
                        };
                        var restarting = app.Start(); PumpUntil(delegate { return restarting.IsCompleted; }, "Restart after cancellation did not finish."); restarting.GetAwaiter().GetResult();
                        if (app.supervisor == null || app.systemStopped || app.stop.Text != "Stop system") throw new Exception("Restart after cancellation failed.");
                        var stopping = app.Stop(); PumpUntil(delegate { return stopping.IsCompleted; }, "Stop after restart did not finish."); stopping.GetAwaiter().GetResult();
                        if (!child.WaitForExit(2000)) throw new Exception("Stop after restart left a child alive."); child.Dispose();
                    }
                }
            }
        }
        static void PumpUntil(Func<bool> condition, string error) {
            var deadline = Stopwatch.StartNew();
            while (!condition() && deadline.ElapsedMilliseconds < 12000) { Application.DoEvents(); Thread.Sleep(5); }
            if (!condition()) throw new Exception(error);
        }
        static Task<Dictionary<string, object>> PipeRequest(string home, string action) {
            return Task.Run(async delegate {
                using (var client = new NamedPipeClientStream(".", TrayCommands.Name(home), PipeDirection.InOut, PipeOptions.Asynchronous)) {
                    client.Connect(2000);
                    byte[] request = Encoding.ASCII.GetBytes(action + "\n"); await client.WriteAsync(request, 0, request.Length);
                    using (var reader = new StreamReader(client)) return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(await reader.ReadLineAsync());
                }
            });
        }
        internal static void TestCommandBridge(string home) {
            string runtime = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".bun", "bin", "bun.exe");
            using (var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset))
            using (var app = new TrayApplication(home, runtime, showEvent)) {
                app.timer.Stop(); var children = new List<Process>(); bool blockStart = false, entered = false;
                app.testControl = async delegate(string action, int pid, CancellationToken token) {
                    if (blockStart && action == "start-components") { entered = true; await Task.Delay(Timeout.Infinite, token); }
                    return new Dictionary<string, object> { { "enabled", false }, { "url", "http://127.0.0.1:1" }, { "gui", "Running" }, { "monitor", "Running" }, { "tunnel", "Running" } };
                };
                app.testSupervisor = delegate(OwnedJob job) {
                    var child = job.Start(runtime, "--no-env-file -e " + OwnedJob.Quote("setInterval(()=>{},1000)"), home, Path.Combine(home, "ipc.out"), Path.Combine(home, "ipc.err"));
                    children.Add(Process.GetProcessById(child.Id)); return child;
                };
                foreach (string action in new[] { "start", "status", "restart", "stop", "stop", "invalid" }) {
                    var request = PipeRequest(home, action);
                    PumpUntil(delegate { return request.IsCompleted; }, "IPC command did not complete: " + action);
                    var result = request.GetAwaiter().GetResult();
                    bool valid = action != "invalid";
                    if (Convert.ToBoolean(result["ok"]) != valid) throw new Exception("Wrong IPC result: " + action);
                    if (valid && Convert.ToString(result["state"]) != (action == "stop" ? "stopped" : "running")) throw new Exception("Wrong IPC state: " + action);
                    if (action == "restart" && !children[0].WaitForExit(2000)) throw new Exception("IPC restart left prior child alive.");
                }
                if (app.supervisor != null || app.window.IsDisposed) throw new Exception("IPC stop must retain only tray/window.");
                blockStart = true;
                var starting = PipeRequest(home, "start");
                PumpUntil(delegate { return entered; }, "IPC start did not reach cancellation phase.");
                var snapshot = PipeRequest(home, "status");
                PumpUntil(delegate { return snapshot.IsCompleted; }, "IPC status blocked behind startup.");
                if (Convert.ToString(snapshot.Result["state"]) != "starting") throw new Exception("IPC status did not report startup.");
                var stopping = PipeRequest(home, "stop");
                PumpUntil(delegate { return starting.IsCompleted && stopping.IsCompleted; }, "IPC stop did not cancel startup.");
                if (Convert.ToBoolean(starting.Result["ok"]) || !Convert.ToBoolean(stopping.Result["ok"]) || app.supervisor != null || !app.systemStopped || app.busy) throw new Exception("IPC cancellation left active state.");
                foreach (var child in children) { if (!child.WaitForExit(2000)) throw new Exception("IPC stop left owned child alive."); child.Dispose(); }
                var closing = PipeRequest(home, "quit");
                PumpUntil(delegate { return closing.IsCompleted && app.window.IsDisposed; }, "IPC quit did not close tray/window.");
                if (!Convert.ToBoolean(closing.Result["ok"]) || app.tray.Visible) throw new Exception("IPC quit failed.");
            }
        }
    }

    public static class Program {
        public static string InstanceName(string root) {
            using (var hash = SHA256.Create()) return "Local\\TeamsMonitorTray_" + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(root).ToLowerInvariant()))).Replace("-", "").Substring(0, 24);
        }
        [STAThread] public static int Main(string[] args) {
            string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
#if AWAKE_SIGNAL_ONLY
            // Separate executable: an older tray build must never mistake a signal for launch.
            return AwakeSignal.Send(root);
#else
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
            string bun = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".bun", "bin", "bun.exe");
            try {
                if (args.Length > 0 && args[0] == "--self-test") { SelfTest(args[1]); return 0; }
                AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs eventArgs) {
                    RecordFatal(root, eventArgs.ExceptionObject as Exception);
                };
                bool created;
                using (var mutex = new Mutex(true, InstanceName(root), out created))
                using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, InstanceName(root) + "_show")) {
                    if (!created) { show.Set(); return 0; }
                    if (!File.Exists(bun)) throw new FileNotFoundException("Bun is missing. Install Bun 1.4+.");
                    using (var app = new TrayApplication(root, bun, show, Array.IndexOf(args, "--agentic") >= 0)) app.Run();
                    mutex.ReleaseMutex();
                }
                return 0;
            } catch (Exception error) {
                if (args.Length > 0 && args[0] == "--self-test") { File.WriteAllText(args[1] + ".failed", error.ToString()); return 1; }
                RecordFatal(root, error);
                MessageBox.Show("TM could not start (" + error.GetType().Name + ").\nCheck the installation and data/desktop logs.", "TM", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
#endif
        }
        static void RecordFatal(string root, Exception error) {
            try {
                string path = Path.Combine(root, "data", "desktop", "tray.log");
                if (File.Exists(path) && new FileInfo(path).Length > 262144) {
                    string old = path + ".1"; if (File.Exists(old)) File.Delete(old); File.Move(path, old);
                }
                File.AppendAllText(path, DateTime.UtcNow.ToString("o") + " fatal type=" +
                    (error == null ? "Unknown" : error.GetType().Name) +
                    (error is Win32Exception ? " nativeCode=" + ((Win32Exception)error).NativeErrorCode : "") + Environment.NewLine);
            } catch { }
        }
        static void SelfTest(string report) {
            SelfTestSaveSignal(report);
            TrayApplication.TestStartupCancellation(Path.GetDirectoryName(report));
            TrayApplication.TestCommandBridge(Path.GetDirectoryName(report));
            var requests = new List<uint>();
            var awake = new KeepAwake(delegate(uint flags) { requests.Add(flags); return 0x80000000; });
            awake.SetActive(true); awake.SetActive(true);
            // Real WinForms close behavior and a suspended child/descendant ownership test.
            using (var window = new TrayWindow()) {
                window.Show(); window.Close();
                if (window.IsDisposed || window.Visible) throw new Exception("Window close must hide, not quit.");
                if (!awake.Active || requests.Count != 1) throw new Exception("Hiding must retain keep-awake request.");
                window.Quitting = true; window.Close();
                if (!window.IsDisposed) throw new Exception("Explicit quit must close.");
            }
            awake.SetActive(false); awake.SetActive(true); awake.Dispose(); awake.Dispose();
            if (awake.Active || requests.Count != 4 || requests[0] != 0x80000003 || requests[1] != 0x80000000 || requests[2] != 0x80000003 || requests[3] != 0x80000000)
                throw new Exception("Keep-awake start/stop/restart/disposal flags failed.");
            Exception wrongThread = null;
            var otherThread = new Thread(delegate() { try { awake.SetActive(true); } catch (Exception error) { wrongThread = error; } });
            otherThread.Start(); otherThread.Join();
            if (!(wrongThread is InvalidOperationException) || requests.Count != 4) throw new Exception("Keep-awake must reject cross-thread use.");
            bool fail = true;
            using (var retry = new KeepAwake(delegate(uint flags) { return fail ? 0u : 0x80000000u; })) {
                if (retry.SetActive(true) || retry.Active || !retry.Failed) throw new Exception("Failed request must not claim active.");
                fail = false;
                if (!retry.SetActive(true) || !retry.Active || retry.Failed) throw new Exception("Keep-awake retry failed.");
                fail = true;
                if (retry.SetActive(false) || !retry.Active || !retry.Failed) throw new Exception("Failed release must remain retryable.");
                fail = false;
                if (!retry.SetActive(false) || retry.Active) throw new Exception("Keep-awake release retry failed.");
            }
            using (var real = new KeepAwake()) {
                if (!real.SetActive(true) || !real.SetActive(false)) throw new Exception("Windows keep-awake acquire/release failed.");
            }
            string temp = Path.GetDirectoryName(report), childPidFile = report + ".child";
            Process parent, child;
            string runtime = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".bun", "bin", "bun.exe");
            using (var job = new OwnedJob()) {
                string script = "const {spawn}=await import('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); c.unref(); await Bun.write(" + new JavaScriptSerializer().Serialize(childPidFile) + ",String(c.pid)); setInterval(()=>{},1000);";
                parent = job.Start(runtime, "-e " + OwnedJob.Quote(script), temp, report + ".out", report + ".err");
                int childPid = 0;
                for (int i = 0; i < 100 && childPid == 0; i++) {
                    try { int.TryParse(File.ReadAllText(childPidFile), out childPid); }
                    catch (IOException) { } // File exists before Bun finishes writing/closing it.
                    if (childPid == 0) Thread.Sleep(50);
                }
                child = Process.GetProcessById(childPid);
                if (!job.Contains(parent) || !job.Contains(child)) throw new Exception("Descendants must belong to owned job.");
                parent.Kill(); parent.WaitForExit(5000);
                if (child.HasExited) throw new Exception("Owned child should survive a parent exit until tray quit.");
            }
            if (!parent.WaitForExit(5000) || !child.WaitForExit(5000)) throw new Exception("Quit must stop the entire owned tree.");
            parent.Dispose(); child.Dispose();
            string instance = InstanceName(temp); bool first, second;
            using (var one = new Mutex(true, instance, out first))
            using (var two = new Mutex(true, instance, out second)) {
                if (!first || second) throw new Exception("Duplicate launch lock failed.");
                one.ReleaseMutex();
            }
            File.WriteAllText(report, "Passed: named-pipe start/status/restart/stop/quit, invalid command rejection, status during startup and stop cancellation; startup cancellation before launch/during health wait/component start, restart after cancel, quit during startup; immediate save signal from helper to UI thread, on/off, absent listener; keep-awake Windows acquire/release, flags, hide retention, stop/restart, failure retries and disposal; close hides; explicit quit closes; child starts in owned job; descendants inherit; job disposal stops entire tree; duplicate launch is locked.");
        }
        static void SelfTestSaveSignal(string report) {
            // A copied helper derives this private home, never the actual installed tray's event.
            string home = Path.Combine(Path.GetDirectoryName(report), "signal-home");
            string bin = Path.Combine(home, "data", "desktop"); Directory.CreateDirectory(bin);
            string helper = Path.Combine(bin, "TM-signal.exe");
            File.Copy(Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "TM-signal.exe"), helper, true);
            int ownerThread = Thread.CurrentThread.ManagedThreadId, applied = 0;
            bool enabled = false;
            var requests = new List<uint>();
            using (var window = new TrayWindow())
            using (var awake = new KeepAwake(delegate(uint flags) { requests.Add(flags); return 0x80000000; })) {
                var handle = window.Handle;
                using (var signal = new AwakeSignal(home, delegate {
                    window.BeginInvoke(new Action(delegate {
                        if (Thread.CurrentThread.ManagedThreadId != ownerThread) throw new Exception("Signal must apply on UI thread.");
                        awake.SetActive(enabled); applied++;
                    }));
                })) {
                    foreach (bool next in new[] { true, false, true, false }) {
                        enabled = next; int previous = applied;
                        using (var sender = Process.Start(new ProcessStartInfo(helper) { UseShellExecute = false, CreateNoWindow = true })) {
                            if (!sender.WaitForExit(2000) || sender.ExitCode != 0) throw new Exception("Save helper must signal an existing listener promptly.");
                        }
                        var deadline = Stopwatch.StartNew();
                        while (applied == previous && deadline.ElapsedMilliseconds < 2000) { Application.DoEvents(); Thread.Sleep(5); }
                        if (applied != previous + 1 || awake.Active != next) throw new Exception("Save must apply without a refresh timer.");
                    }
                    if (requests.Count != 4) throw new Exception("On/off signals must all reach keep-awake.");
                }
                using (var sender = Process.Start(new ProcessStartInfo(helper) { UseShellExecute = false, CreateNoWindow = true })) {
                    if (!sender.WaitForExit(2000) || sender.ExitCode != 2) throw new Exception("An absent tray must not be launched or treated as notified.");
                }
                window.Quitting = true;
            }
        }
    }
}
