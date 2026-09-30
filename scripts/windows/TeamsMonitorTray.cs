using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
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

    sealed class TrayApplication : IDisposable {
        readonly string root, bun, logs, session;
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        OwnedJob job = new OwnedJob();
        readonly EventWaitHandle show;
        readonly NotifyIcon tray;
        readonly TrayWindow window = new TrayWindow();
        readonly Label status = new Label();
        readonly Label awakeStatus = new Label();
        readonly KeepAwake keepAwake = new KeepAwake();
        readonly Button start = new Button();
        readonly Button stop = new Button();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        Process supervisor;
        bool busy, quitting, systemStopped, awakePolicyFailed, keepAwakeEnabled = true;
        int observedExitPid;
        string dashboard = "http://127.0.0.1:8090/";
        public TrayApplication(string project, string runtime, EventWaitHandle showEvent) {
            root = project; bun = runtime; show = showEvent;
            logs = Path.Combine(root, "data", "desktop"); Directory.CreateDirectory(logs);
            session = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff");
            Log("started pid=" + Process.GetCurrentProcess().Id + " parentPid=" + OwnedJob.ParentPid() + " inheritedJob=" + OwnedJob.InAnyJob());
            window.Text = "TM"; window.Size = new Size(480, 295); window.MinimumSize = new Size(480, 295);
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
            stop.Text = "Stop system"; StyleButton(stop); stop.SetBounds(235, 195, 200, 34); stop.Click += async delegate { await Stop(); }; window.Controls.Add(stop);
            var menu = new ContextMenuStrip();
            menu.Items.Add("Show status", null, delegate { Show(); });
            menu.Items.Add("Open dashboard", null, delegate { Open(dashboard); });
            menu.Items.Add("Open logs", null, delegate { Open(Path.Combine(root, "data")); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit TM", null, async delegate { await Quit(); });
            tray = new NotifyIcon { Icon = window.Icon, Text = "TM — starting", ContextMenuStrip = menu, Visible = true };
            tray.DoubleClick += delegate { Show(); };
            timer.Interval = 5000; timer.Tick += async delegate {
                if (show.WaitOne(0)) Show();
                if (!busy && !quitting) await Refresh();
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
        void SetAwake(bool active) {
            active = active && !quitting;
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
        async Task<Dictionary<string, object>> Control(string action, int ownerPid = 0) {
            return await Task.Run(() => {
                using (var process = new Process()) {
                    process.StartInfo = new ProcessStartInfo(bun, "--env-file=.env " + OwnedJob.Quote(Path.Combine(root, "scripts", "tray-control.mjs")) + " " + action + (ownerPid > 0 ? " " + ownerPid : "")) {
                        WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
                    };
                    process.Start();
                    try { job.Attach(process); } catch { if (!process.HasExited) process.Kill(); throw; }
                    var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(25000)) { process.Kill(); throw new TimeoutException(); }
                    Task.WaitAll(output, error);
                    var result = json.Deserialize<Dictionary<string, object>>(output.Result);
                    if (process.ExitCode != 0 || result.ContainsKey("error")) throw new InvalidOperationException(result.ContainsKey("error") ? Convert.ToString(result["error"]) : "LOCAL_CONTROL_FAILED");
                    return result;
                }
            });
        }
        async Task Start() {
            if (busy || quitting) return;
            busy = true; start.Enabled = false; stop.Enabled = false; systemStopped = false; status.Text = "Starting system…";
            try {
                var policy = await Control("awake-policy"); keepAwakeEnabled = Convert.ToBoolean(policy["enabled"]);
                SetAwake(keepAwakeEnabled);
                if (supervisor != null && !supervisor.HasExited) {
                    await Control("resume-components"); Log("components_resumed"); return;
                }
                if (supervisor != null) {
                    Log("replacing_owned_tree supervisorExit=" + supervisor.ExitCode);
                    job.Dispose(); job = new OwnedJob(); supervisor.Dispose(); supervisor = null;
                }
                var description = await Control("describe"); dashboard = Convert.ToString(description["url"]);
                await Control("prepare");
                if (quitting) throw new OperationCanceledException();
                supervisor = job.Start(bun, "--env-file=.env scripts/gui-supervisor.mjs start", root,
                    Path.Combine(logs, "supervisor-" + session + ".out.log"), Path.Combine(logs, "supervisor-" + session + ".err.log"));
                Log("supervisor_started pid=" + supervisor.Id);
                bool ready = false;
                for (int attempt = 0; attempt < 30; attempt++) {
                    if (quitting) throw new OperationCanceledException();
                    if (supervisor.HasExited) throw new InvalidOperationException("SUPERVISOR_EXITED");
                    try { var health = await Control("status"); ready = Convert.ToString(health["gui"]) == "Running"; } catch { }
                    if (ready) break;
                    await Task.Delay(500);
                }
                if (!ready) throw new TimeoutException();
                if (quitting) throw new OperationCanceledException();
                await Control("start-components");
                Log("components_started");
                status.Text = "System started.\n\nClosing this window leaves it running.\nUse the tray icon → Quit TM to stop it.";
                tray.Text = "TM — running";
                tray.ShowBalloonTip(4000, "TM", "Running. Close this window to hide it; use tray → Quit to stop.", ToolTipIcon.Info);
            } catch (Exception error) {
                string code = error is InvalidOperationException ? error.Message : error.GetType().Name;
                Log("startup_failed code=" + code);
                status.Text = code == "EXISTING_SUPERVISOR" ? "A GUI supervisor is already running.\nStop it with bun run gui:stop, then click Start system." :
                    code == "EXISTING_MONITOR" ? "An external monitor is already running.\nStop it from its terminal or dashboard before starting here." :
                    "System needs attention.\nOpen logs for details; the tray remains available.\nIf the GUI started, use Open dashboard for controls.";
                tray.Text = "TM — needs attention";
            } finally { SetAwake(keepAwakeEnabled && supervisor != null && !supervisor.HasExited); busy = false; start.Enabled = true; stop.Enabled = supervisor != null; }
        }
        async Task StopOwnedTree() {
            SetAwake(false);
            if (supervisor != null) {
                try { await Control("stop-owned", supervisor.Id); } catch { Log("api_stop_unavailable owned_tree_will_stop"); }
                await Task.Run(() => supervisor.WaitForExit(5000));
            }
            job.Dispose();
            if (supervisor != null) { supervisor.Dispose(); supervisor = null; }
            if (!quitting) job = new OwnedJob();
            Log("owned_process_tree_stopped");
        }
        async Task Stop() {
            if (busy || quitting) return;
            busy = true; start.Enabled = false; stop.Enabled = false;
            status.Text = "Stopping system…"; tray.Text = "TM — stopping"; Log("system_stop_requested");
            try {
                await StopOwnedTree(); systemStopped = true;
                status.Text = "System stopped.\nClick Start system to start it again.\n\nClosing this window hides the tray app.";
                tray.Text = "TM — stopped";
            } catch (Exception error) {
                Log("system_stop_failed type=" + error.GetType().Name);
                status.Text = "Could not finish stopping.\nOpen logs for details, or quit using the tray icon.";
                tray.Text = "TM — needs attention";
            } finally { busy = false; start.Enabled = true; stop.Enabled = supervisor != null; }
        }
        async Task Refresh() {
            busy = true;
            try {
                if (supervisor == null || supervisor.HasExited) SetAwake(false);
                // Read local config independently of GUI liveness so Off works during recovery.
                try {
                    var policy = await Control("awake-policy"); keepAwakeEnabled = Convert.ToBoolean(policy["enabled"]);
                    if (awakePolicyFailed) Log("keep_awake_policy_read_recovered"); awakePolicyFailed = false;
                } catch {
                    if (!awakePolicyFailed) Log("keep_awake_policy_read_failed retaining_last_setting"); awakePolicyFailed = true;
                }
                SetAwake(keepAwakeEnabled && supervisor != null && !supervisor.HasExited);
                if (supervisor == null || supervisor.HasExited) {
                    SetAwake(false);
                    if (systemStopped) {
                        status.Text = "System stopped.\nClick Start system to start it again.\n\nClosing this window hides the tray app.";
                        tray.Text = "TM — stopped"; return;
                    }
                    if (supervisor != null && observedExitPid != supervisor.Id) {
                        observedExitPid = supervisor.Id;
                        Log("supervisor_exited pid=" + supervisor.Id + " exit=" + supervisor.ExitCode + " hex=0x" + ((uint)supervisor.ExitCode).ToString("X8"));
                    }
                    status.Text = "GUI supervisor stopped.\nClick Start system to start it.\nOpen logs for shutdown evidence.";
                    tray.Text = "TM — supervisor stopped"; return;
                }
                var value = await Control("status");
                status.Text = "GUI supervisor: " + value["gui"] + "\nMonitor: " + value["monitor"] + "\nTunnel: " + value["tunnel"] +
                    "\n\nClose this window to hide it. Quit using the tray icon.";
                bool healthy = Convert.ToString(value["gui"]) == "Running" && Convert.ToString(value["monitor"]) == "Running" && Convert.ToString(value["tunnel"]) == "Running";
                tray.Text = healthy ? "TM — running" : "TM — needs attention";
            } catch { status.Text = "GUI is not responding.\nThe supervisor may be recovering it.\nOpen logs for details."; tray.Text = "TM — GUI unavailable"; }
            finally { busy = false; }
        }
        async Task Quit() {
            if (quitting) return; quitting = true; timer.Stop(); start.Enabled = false; stop.Enabled = false;
            SetAwake(false);
            Log("quit_requested"); status.Text = "Stopping system…"; tray.Text = "TM — stopping";
            // Let an in-progress start/status operation finish before disposing its job.
            while (busy) await Task.Delay(100);
            await StopOwnedTree();
            tray.Visible = false; window.Quitting = true; window.Close(); Application.ExitThread();
        }
        public void Run() { Application.Run(window); }
        public void Dispose() { keepAwake.Dispose(); timer.Dispose(); tray.Dispose(); job.Dispose(); if (supervisor != null) supervisor.Dispose(); window.Dispose(); }
    }

    public static class Program {
        public static string InstanceName(string root) {
            using (var hash = SHA256.Create()) return "Local\\TeamsMonitorTray_" + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(root).ToLowerInvariant()))).Replace("-", "").Substring(0, 24);
        }
        [STAThread] public static int Main(string[] args) {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
            string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
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
                    using (var app = new TrayApplication(root, bun, show)) app.Run();
                    mutex.ReleaseMutex();
                }
                return 0;
            } catch (Exception error) {
                if (args.Length > 0 && args[0] == "--self-test") { File.WriteAllText(args[1] + ".failed", error.ToString()); return 1; }
                RecordFatal(root, error);
                MessageBox.Show("TM could not start (" + error.GetType().Name + ").\nCheck the installation and data/desktop logs.", "TM", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
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
                for (int i = 0; i < 100 && !File.Exists(childPidFile); i++) Thread.Sleep(50);
                child = Process.GetProcessById(int.Parse(File.ReadAllText(childPidFile)));
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
            File.WriteAllText(report, "Passed: keep-awake Windows acquire/release, flags, hide retention, stop/restart, failure retries and disposal; close hides; explicit quit closes; child starts in owned job; descendants inherit; job disposal stops entire tree; duplicate launch is locked.");
        }
    }
}
