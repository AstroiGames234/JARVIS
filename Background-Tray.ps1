$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions

$createdNew = $false
$mutex = [System.Threading.Mutex]::new($false, 'Local\JARVIS_Background_Tray', [ref]$createdNew)
if (-not $createdNew) { exit 0 }

try {
    $references = @(
        [System.Net.WebRequest].Assembly.Location,
        [System.Linq.Enumerable].Assembly.Location,
        [System.Windows.Forms.NotifyIcon].Assembly.Location,
        [System.Drawing.SystemIcons].Assembly.Location,
        [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location
    ) | Select-Object -Unique
    Add-Type -ReferencedAssemblies $references -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace JarvisBackground {
    public static class TrayNative {
        private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

        public static IntPtr FindJarvisWindow() {
            IntPtr found = IntPtr.Zero;
            EnumWindowsProc callback = delegate(IntPtr hwnd, IntPtr lParam) {
                StringBuilder title = new StringBuilder(512);
                GetWindowText(hwnd, title, title.Capacity);
                if (title.ToString().IndexOf("J.A.R.V.I.S.", StringComparison.OrdinalIgnoreCase) >= 0) {
                    found = hwnd;
                    return false;
                }
                return true;
            };
            EnumWindows(callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            return found;
        }
    }

    public sealed class JarvisDarkColorTable : ProfessionalColorTable {
        private static readonly Color Surface = Color.FromArgb(9, 20, 38);
        private static readonly Color SurfaceRaised = Color.FromArgb(14, 32, 56);
        private static readonly Color Border = Color.FromArgb(42, 79, 119);
        private static readonly Color Accent = Color.FromArgb(30, 81, 130);

        public override Color ToolStripDropDownBackground { get { return Surface; } }
        public override Color ImageMarginGradientBegin { get { return Surface; } }
        public override Color ImageMarginGradientMiddle { get { return Surface; } }
        public override Color ImageMarginGradientEnd { get { return Surface; } }
        public override Color MenuItemSelected { get { return Accent; } }
        public override Color MenuItemSelectedGradientBegin { get { return Accent; } }
        public override Color MenuItemSelectedGradientEnd { get { return SurfaceRaised; } }
        public override Color MenuItemPressedGradientBegin { get { return SurfaceRaised; } }
        public override Color MenuItemPressedGradientMiddle { get { return SurfaceRaised; } }
        public override Color MenuItemPressedGradientEnd { get { return SurfaceRaised; } }
        public override Color MenuBorder { get { return Border; } }
        public override Color MenuItemBorder { get { return Border; } }
        public override Color SeparatorDark { get { return Border; } }
        public override Color SeparatorLight { get { return Surface; } }
        public override Color CheckBackground { get { return SurfaceRaised; } }
        public override Color CheckSelectedBackground { get { return Accent; } }
        public override Color CheckPressedBackground { get { return SurfaceRaised; } }
    }

    public static class TrayApp {
        private enum ListenMode { WakeWord, StartingCommand, Command, Processing, AppOwnsMicrophone }
        private static readonly object StateLock = new object();
        private static ListenMode mode = ListenMode.AppOwnsMicrophone;
        private static string pendingCommand = "";
        private static NotifyIcon icon;
        private static Icon customIcon;
        private static ContextMenuStrip menu;
        private static ToolStripMenuItem statusItem;
        private static System.Windows.Forms.Timer ownershipTimer;
        private static System.Windows.Forms.Timer eventTimer;
        private static volatile bool foregroundAppOwnsMicrophone = true;
        private static string lastLocalSpeechError = "";
        public static string IconPath = "";

        public static void Run() {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            BuildTray();
            Application.ApplicationExit += delegate { DisposeSpeech(); };
            try {
                statusItem.Text = "Waiting for microphone owner";
                statusItem.Checked = false;
                icon.Text = "J.A.R.V.I.S. — waiting for microphone owner";
                ReportStatus(false, "Waiting for the app window to claim the microphone.", true, true);
                ownershipTimer = new System.Windows.Forms.Timer { Interval = 1000 };
                ownershipTimer.Tick += delegate { CheckForegroundOwnership(); };
                ownershipTimer.Start();
                eventTimer = new System.Windows.Forms.Timer { Interval = 150 };
                eventTimer.Tick += delegate { if (!foregroundAppOwnsMicrophone) PollWhisperEvent(); };
                eventTimer.Start();
            } catch (Exception error) {
                icon.Text = "J.A.R.V.I.S. — microphone unavailable";
                statusItem.Text = "Voice setup needed";
                statusItem.Checked = false;
                ReportStatus(false, Short(error.Message), false, false);
                ShowNotice("Background voice could not start. " + Short(error.Message));
            }
            Application.Run();
        }

        private static void BuildTray() {
            menu = new ContextMenuStrip();
            menu.BackColor = Color.FromArgb(9, 20, 38);
            menu.ForeColor = Color.FromArgb(222, 237, 253);
            menu.Padding = new Padding(4);
            menu.Renderer = new ToolStripProfessionalRenderer(new JarvisDarkColorTable());
            statusItem = new ToolStripMenuItem("Listening for Jarvis") { Enabled = false, Checked = true, CheckOnClick = false };
            statusItem.ForeColor = Color.FromArgb(139, 194, 246);
            ToolStripMenuItem show = new ToolStripMenuItem("Show J.A.R.V.I.S.");
            ToolStripMenuItem hide = new ToolStripMenuItem("Hide to background");
            ToolStripMenuItem microphoneSettings = new ToolStripMenuItem("Open microphone privacy settings");
            ToolStripMenuItem exit = new ToolStripMenuItem("Exit J.A.R.V.I.S.");
            show.Click += delegate { ShowJarvisWindow(); };
            hide.Click += delegate { HideJarvisWindow(); };
            microphoneSettings.Click += delegate { OpenWindowsSettings("ms-settings:privacy-microphone"); };
            exit.Click += delegate { ExitJarvis(); };
            menu.Items.Add(statusItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(show);
            menu.Items.Add(hide);
            menu.Items.Add(microphoneSettings);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(exit);
            foreach (ToolStripItem item in menu.Items) {
                if (!(item is ToolStripSeparator)) item.BackColor = menu.BackColor;
                if (item != statusItem && !(item is ToolStripSeparator)) item.ForeColor = menu.ForeColor;
            }
            try { if (!String.IsNullOrWhiteSpace(IconPath) && File.Exists(IconPath)) customIcon = new Icon(IconPath); } catch { }
            icon = new NotifyIcon {
                Icon = customIcon ?? SystemIcons.Application,
                Text = "J.A.R.V.I.S. — listening for Jarvis",
                ContextMenuStrip = menu,
                Visible = true
            };
            icon.DoubleClick += delegate { ShowJarvisWindow(); };
        }

        private static string ListeningStatus() {
            return "Listening for Jarvis in the tray with offline Whisper. Spoken replies use the local J.A.R.V.I.S. voice.";
        }

        private static bool TrySpeakLocal(string text) {
            try {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                byte[] data = Encoding.UTF8.GetBytes(serializer.Serialize(new Dictionary<string, object> { { "text", text ?? "" } }));
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:48123/api/tts");
                request.Method = "POST";
                request.ContentType = "application/json; charset=utf-8";
                request.Timeout = 35000;
                request.ReadWriteTimeout = 35000;
                request.ContentLength = data.Length;
                using (Stream stream = request.GetRequestStream()) stream.Write(data, 0, data.Length);
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (MemoryStream audio = new MemoryStream()) {
                    response.GetResponseStream().CopyTo(audio);
                    byte[] wav = audio.ToArray();
                    if (wav.Length < 44 || Encoding.ASCII.GetString(wav, 0, 4) != "RIFF" || Encoding.ASCII.GetString(wav, 8, 4) != "WAVE") return false;
                    audio.Position = 0;
                    using (System.Media.SoundPlayer player = new System.Media.SoundPlayer(audio)) {
                        player.Load();
                        player.PlaySync();
                    }
                    return true;
                }
            } catch (WebException error) {
                lastLocalSpeechError = Short(error.Message);
                try {
                    using (WebResponse response = error.Response)
                    using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                        Dictionary<string, object> body = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                        object detail;
                        if (body != null && body.TryGetValue("error", out detail) && detail is string) lastLocalSpeechError = Short((string)detail);
                    }
                } catch { }
                return false;
            } catch (Exception error) {
                lastLocalSpeechError = Short(error.Message);
                return false;
            }
        }

        private static void ShowLocalSpeechUnavailable() {
            string detail = String.IsNullOrWhiteSpace(lastLocalSpeechError) ? "" : " " + lastLocalSpeechError;
            ShowNotice("Local J.A.R.V.I.S. speech is unavailable." + detail + " Run Setup-Local-AI.cmd from the app folder.");
        }

        private static void ProcessCommand(string command) {
            string response;
            if (String.IsNullOrWhiteSpace(command)) {
                response = "I didn’t catch that, sir. Say Jarvis when you’re ready.";
            } else {
                try {
                    response = SendCommand(command);
                } catch (Exception error) {
                    response = "I’m sorry, sir. " + Short(error.Message);
                }
            }
            bool appSpoke = TrySpeakInApp(response);
            if (!appSpoke && !TrySpeakLocal(response)) ShowLocalSpeechUnavailable();
            RestoreWakeListening("I’m listening again, sir.");
        }

        private static string SendCommand(string command) {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            byte[] data = Encoding.UTF8.GetBytes(serializer.Serialize(new Dictionary<string, object> { { "command", command } }));
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:48123/api/assistant-command");
            request.Method = "POST";
            request.ContentType = "application/json; charset=utf-8";
            request.Timeout = 55000;
            request.ReadWriteTimeout = 55000;
            request.ContentLength = data.Length;
            using (Stream stream = request.GetRequestStream()) stream.Write(data, 0, data.Length);
            try {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                    Dictionary<string, object> result = serializer.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    object text;
                    if (result != null && result.TryGetValue("response", out text) && text is string && !String.IsNullOrWhiteSpace((string)text)) return (string)text;
                    if (result != null && result.TryGetValue("error", out text) && text is string) return (string)text;
                }
            } catch (WebException error) {
                HttpWebResponse response = error.Response as HttpWebResponse;
                if (response == null) throw new InvalidOperationException("The local assistant server is not running.", error);
                using (response)
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                    Dictionary<string, object> result = serializer.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    object detail;
                    if (result != null && result.TryGetValue("error", out detail) && detail is string && !String.IsNullOrWhiteSpace((string)detail)) return (string)detail;
                }
                throw new InvalidOperationException("The local assistant could not complete that request.", error);
            }
            return "I could not complete that request, sir.";
        }

        private static bool TrySpeakInApp(string text) {
            try {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                byte[] data = Encoding.UTF8.GetBytes(serializer.Serialize(new Dictionary<string, object> { { "text", text } }));
                HttpWebRequest create = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:48123/api/background/speech");
                create.Method = "POST";
                create.ContentType = "application/json; charset=utf-8";
                create.Timeout = 2000;
                create.ContentLength = data.Length;
                using (Stream stream = create.GetRequestStream()) stream.Write(data, 0, data.Length);
                string id;
                using (HttpWebResponse response = (HttpWebResponse)create.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                    Dictionary<string, object> created = serializer.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    object value;
                    if (created == null || !created.TryGetValue("id", out value) || !(value is string)) return false;
                    id = (string)value;
                }
                for (int attempt = 0; attempt < 240; attempt++) {
                    Thread.Sleep(250);
                    HttpWebRequest check = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:48123/api/background/speech/result?id=" + Uri.EscapeDataString(id));
                    check.Timeout = 2000;
                    using (HttpWebResponse response = (HttpWebResponse)check.GetResponse())
                    using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                        Dictionary<string, object> state = serializer.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                        object complete, handled, claimed;
                        if (state != null && state.TryGetValue("complete", out complete) && complete is bool && (bool)complete) {
                            return state.TryGetValue("handled", out handled) && handled is bool && (bool)handled;
                        }
                        if (attempt >= 20 && state != null && state.TryGetValue("claimed", out claimed) && claimed is bool && !(bool)claimed) return false;
                    }
                }
            } catch { }
            return false;
        }

        private static void ReportStatus(bool ready, string message, bool foregroundPaused, bool available) {
            try {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                byte[] data = Encoding.UTF8.GetBytes(serializer.Serialize(new Dictionary<string, object> {
                    { "ready", ready }, { "message", message }, { "foregroundPaused", foregroundPaused }, { "available", available }
                }));
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:48123/api/background/status");
                request.Method = "POST";
                request.ContentType = "application/json; charset=utf-8";
                request.Timeout = 1500;
                request.ReadWriteTimeout = 1500;
                request.ContentLength = data.Length;
                using (Stream stream = request.GetRequestStream()) stream.Write(data, 0, data.Length);
                using (WebResponse response = request.GetResponse()) { }
            } catch { }
        }

        private static void CheckForegroundOwnership() {
            bool active = false;
            try {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:48123/api/foreground/status");
                request.Timeout = 800;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                    Dictionary<string, object> result = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    object value;
                    active = result != null && result.TryGetValue("active", out value) && value is bool && (bool)value;
                }
            } catch { return; }
            foregroundAppOwnsMicrophone = active;
            if (active) {
                StopWhisperListener();
                lock (StateLock) { mode = ListenMode.AppOwnsMicrophone; pendingCommand = ""; }
                if (statusItem != null) { statusItem.Text = "App has microphone priority"; statusItem.Checked = false; }
                if (icon != null) icon.Text = "J.A.R.V.I.S. — app has microphone priority";
                ReportStatus(false, "The visible app owns the microphone.", true, true);
                return;
            }

            ListenMode current;
            lock (StateLock) current = mode;
            if (current == ListenMode.AppOwnsMicrophone) {
                lock (StateLock) { mode = ListenMode.WakeWord; pendingCommand = ""; }
                current = ListenMode.WakeWord;
            }
            lock (StateLock) current = mode;
            if (current == ListenMode.Processing || current == ListenMode.StartingCommand) return;
            try {
                Dictionary<string, object> state = SendListenerRequest("/api/background/listener/status", "GET", null, 1200);
                object running, listening, error;
                bool isRunning = state != null && state.TryGetValue("running", out running) && running is bool && (bool)running;
                bool isListening = state != null && state.TryGetValue("listening", out listening) && listening is bool && (bool)listening;
                if (state != null && state.TryGetValue("error", out error) && error is string && !String.IsNullOrWhiteSpace((string)error)) {
                    ReportStatus(false, Short((string)error), false, false);
                    if (statusItem != null) statusItem.Text = "Offline voice setup needed";
                    if (icon != null) icon.Text = "J.A.R.V.I.S. — voice setup needed";
                    return;
                }
                if (!isRunning && current == ListenMode.WakeWord) {
                    string detail;
                    if (!SetWhisperMode("wake", out detail)) {
                        ReportStatus(false, Short(detail), false, false);
                        if (statusItem != null) statusItem.Text = "Offline voice unavailable";
                        if (icon != null) icon.Text = "J.A.R.V.I.S. — offline voice unavailable";
                        return;
                    }
                    isListening = false;
                }
                if (statusItem != null) { statusItem.Text = isListening ? "Listening for Jarvis in background" : "Starting offline voice listener"; statusItem.Checked = true; }
                if (icon != null) icon.Text = isListening ? "J.A.R.V.I.S. — listening in background" : "J.A.R.V.I.S. — starting voice listener";
                ReportStatus(true, ListeningStatus(), false, true);
            } catch (Exception error) {
                ReportStatus(false, Short(error.Message), false, false);
            }
        }

        private static void RestoreWakeListening(string notice) {
            try {
                if (foregroundAppOwnsMicrophone) {
                    StopWhisperListener();
                    lock (StateLock) {
                        mode = ListenMode.AppOwnsMicrophone;
                        pendingCommand = "";
                    }
                    UpdateTrayStatus("App has microphone priority", "J.A.R.V.I.S. — app has microphone priority", false);
                    ReportStatus(false, "The visible app owns the microphone.", true, true);
                    return;
                }
                string detail;
                if (!SetWhisperMode("wake", out detail)) throw new InvalidOperationException(detail);
                lock (StateLock) {
                    mode = ListenMode.WakeWord;
                    pendingCommand = "";
                }
                UpdateTrayStatus("Starting offline voice listener", "J.A.R.V.I.S. — starting voice listener", true);
                ReportStatus(true, ListeningStatus(), false, true);
            } catch (Exception error) {
                ReportStatus(false, Short(error.Message), foregroundAppOwnsMicrophone, true);
                ShowNotice("Wake listening stopped. " + Short(error.Message));
            }
        }

        private static void UpdateTrayStatus(string label, string tooltip, bool isChecked) {
            if (menu == null || menu.IsDisposed) return;
            if (menu.InvokeRequired) {
                try { menu.BeginInvoke(new MethodInvoker(delegate { UpdateTrayStatus(label, tooltip, isChecked); })); } catch { }
                return;
            }
            if (statusItem != null) { statusItem.Text = label; statusItem.Checked = isChecked; }
            if (icon != null) icon.Text = tooltip;
        }

        private static Dictionary<string, object> SendListenerRequest(string route, string method, Dictionary<string, object> body, int timeout) {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:48123" + route);
            request.Method = method;
            request.Timeout = timeout;
            request.ReadWriteTimeout = timeout;
            if (body != null) {
                byte[] data = Encoding.UTF8.GetBytes(serializer.Serialize(body));
                request.ContentType = "application/json; charset=utf-8";
                request.ContentLength = data.Length;
                using (Stream stream = request.GetRequestStream()) stream.Write(data, 0, data.Length);
            }
            try {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                    return serializer.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                }
            } catch (WebException error) {
                if (error.Response == null) throw new InvalidOperationException("The local J.A.R.V.I.S. speech service is unavailable.", error);
                using (WebResponse response = error.Response)
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                    Dictionary<string, object> result = serializer.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    object detail;
                    if (result != null && result.TryGetValue("error", out detail) && detail is string) throw new InvalidOperationException((string)detail);
                }
                throw new InvalidOperationException("The local J.A.R.V.I.S. speech service rejected the request.", error);
            }
        }

        private static bool SetWhisperMode(string listenMode, out string detail) {
            try {
                Dictionary<string, object> result = SendListenerRequest("/api/background/listener/start", "POST", new Dictionary<string, object> { { "mode", listenMode } }, 1500);
                object error;
                if (result != null && result.TryGetValue("error", out error) && error is string) {
                    detail = (string)error;
                    return false;
                }
                detail = "";
                return result != null && result.ContainsKey("running");
            } catch (Exception error) {
                detail = error.Message;
                return false;
            }
        }

        private static void StopWhisperListener() {
            try { SendListenerRequest("/api/background/listener/stop", "POST", new Dictionary<string, object>(), 800); } catch { }
        }

        private static void PollWhisperEvent() {
            if (foregroundAppOwnsMicrophone) return;
            Dictionary<string, object> result;
            try { result = SendListenerRequest("/api/background/listener/event", "GET", null, 500); }
            catch { return; }
            object eventValue;
            Dictionary<string, object> eventData = result != null && result.TryGetValue("event", out eventValue) ? eventValue as Dictionary<string, object> : null;
            if (eventData == null) return;
            object rawKind, rawText, rawMode;
            string kind = eventData.TryGetValue("kind", out rawKind) && rawKind is string ? (string)rawKind : "";
            string text = eventData.TryGetValue("text", out rawText) && rawText is string ? ((string)rawText).Trim() : "";
            string sourceMode = eventData.TryGetValue("mode", out rawMode) && rawMode is string ? (string)rawMode : "";
            if (kind == "timeout") {
                if (sourceMode == "command") {
                    lock (StateLock) mode = ListenMode.WakeWord;
                    if (!TrySpeakLocal("I didn’t catch that, sir. Say Jarvis when you’re ready.")) ShowLocalSpeechUnavailable();
                    RestoreWakeListening("I’m listening again, sir.");
                }
                return;
            }
            if (kind != "recognized" || String.IsNullOrWhiteSpace(text)) return;
            if (sourceMode == "wake") {
                Match wake = Regex.Match(text, @"^(?:(?:hey|hay|ay)\s+)?(?:jarvis|jervis|jarvus|jarviss|jarviz|jaarvis|jarvys|jarves|jarvies|jharvis|jarvish|javis|jarvy|jarvin|jarvee|jar\s+vis|jar\s+viz|j[\s.-]*a[\s.-]*r[\s.-]*v[\s.-]*i[\s.-]*s)\b[\s,.:;!?-]*(.*)$", RegexOptions.IgnoreCase);
                if (!wake.Success) return;
                string command = wake.Groups[1].Value.Trim();
                if (String.IsNullOrWhiteSpace(command)) {
                    lock (StateLock) mode = ListenMode.StartingCommand;
                    if (!TrySpeakLocal("Yes, sir?")) ShowLocalSpeechUnavailable();
                    if (foregroundAppOwnsMicrophone) return;
                    string detail;
                    if (!SetWhisperMode("command", out detail)) {
                        ShowNotice("I could not start command listening. " + Short(detail));
                        RestoreWakeListening("I’m listening again, sir.");
                        return;
                    }
                    lock (StateLock) mode = ListenMode.Command;
                    if (statusItem != null) statusItem.Text = "Listening for your command";
                    return;
                }
                lock (StateLock) { mode = ListenMode.Processing; pendingCommand = command; }
                ThreadPool.QueueUserWorkItem(delegate { ProcessCommand(command); });
            } else if (sourceMode == "command") {
                lock (StateLock) { mode = ListenMode.Processing; pendingCommand = text; }
                ThreadPool.QueueUserWorkItem(delegate { ProcessCommand(text); });
            }
        }

        private static bool FullscreenPreference() {
            try {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:48123/api/window/fullscreen");
                request.Timeout = 1500;
                using (WebResponse response = request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream())) {
                    Dictionary<string, object> result = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    object enabled;
                    return result != null && result.TryGetValue("enabled", out enabled) ? Convert.ToBoolean(enabled) : true;
                }
            } catch { return true; }
        }

        private static void ShowJarvisWindow() {
            IntPtr window = TrayNative.FindJarvisWindow();
            if (window == IntPtr.Zero) {
                string edge = new[] {
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "Edge", "Application", "msedge.exe")
                }.FirstOrDefault(File.Exists);
                try {
                    if (!String.IsNullOrEmpty(edge)) Process.Start(edge, "--app=http://127.0.0.1:48123 --new-window" + (FullscreenPreference() ? " --start-fullscreen" : ""));
                    else Process.Start("http://127.0.0.1:48123");
                } catch { }
                for (int i = 0; i < 40 && window == IntPtr.Zero; i++) {
                    Thread.Sleep(250);
                    window = TrayNative.FindJarvisWindow();
                }
            }
            if (window != IntPtr.Zero) {
                TrayNative.ShowWindow(window, 9);
                TrayNative.SetForegroundWindow(window);
            }
        }

        private static void HideJarvisWindow() {
            IntPtr window = TrayNative.FindJarvisWindow();
            if (window != IntPtr.Zero) TrayNative.ShowWindow(window, 0);
        }

        private static void OpenWindowsSettings(string address) {
            try { Process.Start(new ProcessStartInfo { FileName = address, UseShellExecute = true }); }
            catch (Exception error) { ShowNotice("Windows Settings could not open. " + Short(error.Message)); }
        }

        private static void ExitJarvis() {
            IntPtr window = TrayNative.FindJarvisWindow();
            if (window != IntPtr.Zero) TrayNative.PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
            try {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:48123/api/shutdown");
                request.Method = "POST";
                request.ContentType = "application/json";
                request.Timeout = 2500;
                request.ReadWriteTimeout = 2500;
                request.ContentLength = 2;
                using (Stream stream = request.GetRequestStream()) stream.Write(new byte[] { 123, 125 }, 0, 2);
                using (WebResponse response = request.GetResponse()) { }
            } catch { }
            try { DisposeSpeech(); } catch { }
            Application.ExitThread();
        }

        private static void ShowNotice(string message) {
            try {
                icon.BalloonTipTitle = "J.A.R.V.I.S. Background Voice";
                icon.BalloonTipText = Short(message);
                icon.BalloonTipIcon = ToolTipIcon.Info;
                icon.ShowBalloonTip(5000);
            } catch { }
        }

        private static string Short(string text) {
            if (String.IsNullOrWhiteSpace(text)) return "Please check the tray voice setup.";
            string clean = text.Replace('\r', ' ').Replace('\n', ' ').Trim();
            return clean.Length > 180 ? clean.Substring(0, 177) + "..." : clean;
        }

        private static void DisposeSpeech() {
            try { if (ownershipTimer != null) { ownershipTimer.Stop(); ownershipTimer.Dispose(); } } catch { }
            try { if (eventTimer != null) { eventTimer.Stop(); eventTimer.Dispose(); } } catch { }
            StopWhisperListener();
            try { if (icon != null) { icon.Visible = false; icon.Dispose(); } } catch { }
            try { if (customIcon != null) customIcon.Dispose(); } catch { }
            try { if (menu != null) menu.Dispose(); } catch { }
        }
    }
}
'@
    [JarvisBackground.TrayApp]::IconPath = Join-Path $PSScriptRoot 'jarvis.ico'
    [JarvisBackground.TrayApp]::Run()
} finally {
    $mutex.Dispose()
}
